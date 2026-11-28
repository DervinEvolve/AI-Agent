export interface StructuredFeedbackItem {
  code: string;
  pointer: string;
  keyword: string;
}

export const UNTRUSTED_FEEDBACK_LABEL = "UNTRUSTED_STRUCTURED_FEEDBACK";

const ALLOWED = new Set(["code", "pointer", "keyword"]);

export function buildStructuredFeedback(
  errors: readonly unknown[],
  limits: { maxErrors: number; maxErrorBytes: number },
): { items: StructuredFeedbackItem[]; bytes: number; labelled: string } {
  const maxErrors = Math.max(0, limits.maxErrors);
  const maxBytes = Math.max(0, limits.maxErrorBytes);
  const items: StructuredFeedbackItem[] = [];
  for (const raw of errors) {
    if (items.length >= maxErrors) break;
    const item = stripError(raw);
    if (!item) continue;
    const next = items.concat(item);
    const bytes = Buffer.byteLength(JSON.stringify(next), "utf8");
    if (bytes > maxBytes) break;
    items.push(item);
  }
  const body = JSON.stringify(items);
  return {
    items,
    bytes: Buffer.byteLength(body, "utf8"),
    labelled: `${UNTRUSTED_FEEDBACK_LABEL}\n${body}`,
  };
}

function stripError(raw: unknown): StructuredFeedbackItem | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const keyword = typeof rec.keyword === "string" ? rec.keyword : "";
  const code = typeof rec.code === "string" && rec.code.length > 0 ? rec.code : keyword || "schema";
  const pointer =
    typeof rec.pointer === "string"
      ? rec.pointer
      : typeof rec.instancePath === "string"
        ? rec.instancePath
        : "";
  if (!keyword && !pointer && code === "schema") {
    if (typeof rec.keyword !== "string" && typeof rec.pointer !== "string" && typeof rec.code !== "string") {
      return null;
    }
  }
  const item: StructuredFeedbackItem = { code, pointer, keyword };
  for (const key of Object.keys(item)) {
    if (!ALLOWED.has(key)) return null;
  }
  return item;
}

export function feedbackContainsAnswer(labelled: string, answer: string): boolean {
  if (!answer) return false;
  return labelled.includes(answer);
}
