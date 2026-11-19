import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  PREVIEW_CAP_BYTES,
  readSpillSlice,
  recallSpillTail,
  truncateWithSpill,
  verifyOmittedTailRecovered,
} from "../output_spill";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "output-spill-eval-"));
const spillDir = path.join(tmpRoot, "workspace", ".spill");

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Eval scenario: agent writes a ~500KB file (99 padded lines + final
 * "LINE 0099" marker), prints it via run_code (stdout clipped beyond the
 * ~50KB preview cap), then uses recall to page back the omitted tail and
 * verifies the ending marker without re-executing the tool.
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

describe("eval: truncation + recall of omitted tail", () => {
  it("run_code observation truncates ~500KB stdout and spills full output", () => {
    const big = makeLargeOutput();
    const totalBytes = Buffer.byteLength(big, "utf8");
    expect(totalBytes).toBeGreaterThan(400 * 1024);

    const res = truncateWithSpill(big, { spillDir });

    // Trigger condition: stdout_truncated true, stdout_spill_path present.
    expect(res.truncated).toBe(true);
    expect(res.metadata.stdout_truncated).toBe(true);
    expect(res.metadata.stdout_bytes_total).toBe(totalBytes);
    expect(res.metadata.stdout_bytes_omitted).toBeGreaterThan(0);
    expect(typeof res.metadata.stdout_spill_path).toBe("string");
    expect(res.metadata.stdout_spill_path).not.toBeNull();

    // The preview must be within budget and must NOT contain the tail marker.
    expect(Buffer.byteLength(res.content, "utf8")).toBeLessThanOrEqual(
      PREVIEW_CAP_BYTES + 1024,
    );
    expect(res.content).not.toContain("LINE 0099");

    // The spill file contains the full, untruncated output.
    const spilled = fs.readFileSync(res.metadata.stdout_spill_path as string, "utf8");
    expect(spilled).toBe(big);
  });

  it("recall pages back the omitted tail and verifies LINE 0099 without re-running", () => {
    const big = makeLargeOutput();
    const res = truncateWithSpill(big, { spillDir });
    const spillPath = res.metadata.stdout_spill_path as string;

    // Agent revises plan: instead of re-executing run_code, recall the tail.
    const tail = recallSpillTail(spillPath, 200);
    expect(tail.trimEnd().endsWith("LINE 0099")).toBe(true);
    expect(tail).toContain("LINE 0099");

    // Full verification helper agrees the omitted tail was recovered.
    const verified = verifyOmittedTailRecovered(res, "LINE 0099");
    expect(verified).toBe(true);

    // Offloading the full result: paging from the end via readSpillSlice
    // also reaches the marker without re-executing the tool.
    const total = res.metadata.stdout_bytes_total as number;
    const lastSlice = readSpillSlice(spillPath, Math.max(0, total - 4096));
    expect(lastSlice).toContain("LINE 0099");
  });

  it("recallSpillTail on a small non-spilled output is not required (no spill path)", () => {
    const res = truncateWithSpill("tiny output", { spillDir });
    expect(res.metadata.stdout_spill_path).toBeNull();
    expect(res.truncated).toBe(false);
  });
});
