import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  afterAll,
  describe,
  expect,
  it,
} from "vitest";

import {
  PREVIEW_CAP_BYTES,
  SPILL_HARD_CAP_BYTES,
  readSpillSlice,
  recallSpillFind,
  recallSpillTail,
  redactSecrets,
  truncateWithSpill,
  verifyOmittedTailRecovered,
} from "../output_spill";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "output-spill-test-"));
const spillDir = path.join(tmpRoot, "workspace", ".spill");

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * The eval scenario: a ~500KB file whose last line is "LINE 0099".
 * 100 lines of ~5KB each ≈ 500KB, comfortably over the 50KB preview cap.
 */
function makeLargeOutput(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 99; i++) {
    const tag = `LINE ${String(i).padStart(4, "0")}`;
    const filler = "x".repeat(5 * 1024 - tag.length - 1);
    lines.push(`${tag} ${filler}`);
  }
  lines.push("LINE 0099");
  return lines.join("\n");
}

describe("truncateWithSpill", () => {
  it("passes small output through untouched with no spill", () => {
    const res = truncateWithSpill("hello world", { spillDir });
    expect(res.truncated).toBe(false);
    expect(res.content).toBe("hello world");
    expect(res.spillPath).toBeNull();
    expect(res.metadata.stdout_truncated).toBe(false);
    expect(res.metadata.stdout_bytes_omitted).toBe(0);
    expect(res.metadata.stdout_spill_path).toBeNull();
  });

  it("truncates ~500KB output, spills the full content, and reports metadata", () => {
    const big = makeLargeOutput();
    expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(400 * 1024);

    const res = truncateWithSpill(big, { spillDir });

    expect(res.truncated).toBe(true);
    expect(res.metadata.stdout_truncated).toBe(true);
    expect(res.metadata.stdout_bytes_total).toBe(
      Buffer.byteLength(big, "utf8"),
    );
    expect(res.metadata.stdout_bytes_omitted).toBeGreaterThan(400 * 1024);
    expect(res.spillPath).not.toBeNull();
    expect(res.metadata.stdout_spill_path).toBe(res.spillPath);
    expect(res.spillFailed).toBe(false);
    expect(fs.existsSync(res.spillPath!)).toBe(true);

    // Preview is bounded and carries the teaching marker.
    expect(Buffer.byteLength(res.content, "utf8")).toBeLessThan(
      PREVIEW_CAP_BYTES + 4096,
    );
    expect(res.content).toContain("[... stdout truncated ...]");
    expect(res.content).toContain(res.spillPath!);
    expect(res.content).toContain("readSpillSlice");

    // The spill file holds the full content byte-for-byte.
    const spilled = fs.readFileSync(res.spillPath!, "utf8");
    expect(spilled).toBe(big);
  });

  it("is content-keyed: identical output reuses the same spill file", () => {
    const big = makeLargeOutput();
    const a = truncateWithSpill(big, { spillDir });
    const b = truncateWithSpill(big, { spillDir });
    expect(a.spillPath).toBe(b.spillPath);
  });

  it("degrades to plain clipping when the spill write fails", () => {
    const big = makeLargeOutput();
    const res = truncateWithSpill(big, {
      // spillDir points at an existing *file*, so mkdir/write fails
      spillDir: path.join(tmpRoot, "not-a-dir", "sub"),
      contentKey: "degrade-test",
    });
    // force failure: make the parent a regular file
    fs.writeFileSync(path.join(tmpRoot, "not-a-dir"), "x");
    const res2 = truncateWithSpill(big, {
      spillDir: path.join(tmpRoot, "not-a-dir", "sub"),
      contentKey: "degrade-test-2",
    });
    expect(res2.truncated).toBe(true);
    expect(res2.spillFailed).toBe(true);
    expect(res2.spillPath).toBeNull();
    expect(res2.metadata.stdout_spill_path).toBeNull();
    expect(res2.metadata.stdout_truncated).toBe(true);
    expect(res2.content).toContain("spill unavailable");
    expect(res.truncated).toBe(true);
  });

  it("refuses to spill beyond the 5MB hard cap (plain clipping only)", () => {
    const huge = "y".repeat(SPILL_HARD_CAP_BYTES + 1024);
    const res = truncateWithSpill(huge, { spillDir });
    expect(res.truncated).toBe(true);
    expect(res.spillPath).toBeNull();
    expect(res.spillFailed).toBe(false); // deliberately not attempted
    expect(res.metadata.stdout_bytes_total).toBe(SPILL_HARD_CAP_BYTES + 1024);
  });

  it("redacts secrets from the spill before persisting", () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const lines = ["start", `aws_key=${secret}`, "middle"];
    const filler = "z".repeat(PREVIEW_CAP_BYTES + 1024);
    const big = lines.join("\n") + "\n" + filler + "\nLINE 0099\n";
    const res = truncateWithSpill(big, { spillDir, contentKey: "redact-test" });
    expect(res.spillPath).not.toBeNull();
    const spilled = fs.readFileSync(res.spillPath!, "utf8");
    expect(spilled).not.toContain(secret);
    expect(spilled).toContain("[REDACTED]");
    expect(redactSecrets(`token=abc123def456ghi789`)).toBe("[REDACTED]");
  });
});

describe("recall-driven tail recovery (eval flow)", () => {
  it("agent writes ~500KB file, run_code truncates, recall fetches the missing tail verifying LINE 0099 without re-executing", () => {
    // Step 1: the agent writes a ~500KB file and prints it (simulated stdout).
    const file = makeLargeOutput();
    const stdout = file; // what run_code would emit

    // Step 2: run_code output goes through bounded capture with spill.
    const res = truncateWithSpill(stdout, { spillDir, contentKey: "eval-flow" });
    expect(res.truncated).toBe(true);
    expect(res.spillPath).not.toBeNull();

    // Step 3: the ending marker must NOT be visible in the truncated preview.
    // The preview's tail is the last ~60% of the 50KB cap... but our file's
    // last line is tiny, so verify the omitted-region contract precisely:
    const verification = verifyOmittedTailRecovered(res, "LINE 0099");
    // "LINE 0099" is the final line; the preview tail slice should not have
    // reached it because the omitted middle is >400KB.
    expect(verification.inSpill).toBe(true);

    // Step 4: recall pages the tail back from the spill file (no re-execution).
    const tail = recallSpillTail(res.spillPath!, 8 * 1024);
    expect(tail.atEnd).toBe(true);
    expect(tail.lines.length).toBeGreaterThan(0);
    expect(tail.lines[tail.lines.length - 1]).toBe("LINE 0099");

    // Step 5: needle search confirms the ending marker in the spill.
    const found = recallSpillFind(res.spillPath!, "LINE 0099");
    expect(found).not.toBeNull();
    expect(found!.text).toContain("LINE 0099");

    // Step 6: the agent revises its plan to offload the full result: it now
    // reads slices by offset instead of re-running the tool.
    const slice = readSpillSlice(res.spillPath!, {
      offset: Math.max(0, tail.totalBytes - 4096),
      maxBytes: 4096,
    });
    expect(slice.atEnd).toBe(true);
    expect(slice.content.trim().endsWith("LINE 0099")).toBe(true);
  });

  it("readSpillSlice pages forward from an offset with byte accounting", () => {
    const big = makeLargeOutput();
    const res = truncateWithSpill(big, { spillDir, contentKey: "paging" });
    const first = readSpillSlice(res.spillPath!, { offset: 0, maxBytes: 1024 });
    expect(first.offset).toBe(0);
    expect(first.lengthBytes).toBe(1024);
    expect(first.atEnd).toBe(false);
    const second = readSpillSlice(res.spillPath!, {
      offset: first.offset + first.lengthBytes,
      maxBytes: 1024,
    });
    expect(second.offset).toBe(1024);
    expect(second.content).not.toEqual(first.content);
  });

  it("handles invalid utf8 bytes without throwing (replacement semantics)", () => {
    const file = path.join(spillDir, "binary-spill.txt");
    fs.writeFileSync(file, Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    const slice = readSpillSlice(file);
    expect(slice.lengthBytes).toBe(4);
    expect(typeof slice.content).toBe("string");
  });

  it("recallSpillFind returns null for a missing needle", () => {
    const big = makeLargeOutput();
    const res = truncateWithSpill(big, { spillDir, contentKey: "missing" });
    expect(recallSpillFind(res.spillPath!, "DOES_NOT_EXIST")).toBeNull();
  });
});
