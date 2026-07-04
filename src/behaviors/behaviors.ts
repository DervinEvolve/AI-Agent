import * as multimodalGrounding11Module from "./beh_multimodal_grounding_11";
import { beh_trace_grounded_self_evaluation_18 } from "./beh_trace_grounded_self_evaluation_18";

type BehaviorRecord = {
  id: string;
  name?: string;
  status?: string;
  description?: string;
  implementation?: unknown;
};

function firstBehaviorExport(moduleExports: Record<string, unknown>, preferred: string): BehaviorRecord {
  const preferredExport = moduleExports[preferred];
  if (isBehaviorRecord(preferredExport)) {
    return preferredExport;
  }

  const defaultExport = moduleExports.default;
  if (isBehaviorRecord(defaultExport)) {
    return defaultExport;
  }

  const first = Object.values(moduleExports).find(isBehaviorRecord);
  if (first) {
    return first;
  }

  throw new Error(`No behavior export found for ${preferred}`);
}

function isBehaviorRecord(value: unknown): value is BehaviorRecord {
  return Boolean(value && typeof value === "object" && "id" in value && typeof (value as { id?: unknown }).id === "string");
}

export const beh_multimodal_grounding_11 = firstBehaviorExport(
  multimodalGrounding11Module as Record<string, unknown>,
  "beh_multimodal_grounding_11",
);

export { beh_trace_grounded_self_evaluation_18 };

export const behaviors = [beh_multimodal_grounding_11, beh_trace_grounded_self_evaluation_18];

export default behaviors;
