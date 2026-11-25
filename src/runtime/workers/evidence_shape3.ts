import { EVIDENCE_SHAPE_WORKER_POLL } from "./types.js";

export interface Shape3Input {
  poll_call_id: string;
  child_call_id: string;
  worker_id: string;
  exposed_citation_ids: readonly string[];
  successful_child_calls: ReadonlyMap<string, { worker_id: string; classifier_ok: boolean }>;
}

export interface Shape3Result {
  shape: typeof EVIDENCE_SHAPE_WORKER_POLL;
  ok: boolean;
  reason?: string;
}

/**
 * EvidenceValidator shape 3: poll_agent call_id plus child_call_id.
 * The child id must belong to that worker, have a classifier-successful result,
 * and appear in the exposed citation list of that exact poll result.
 */
export function validateWorkerEvidenceShape3(input: Shape3Input): Shape3Result {
  const rec = input.successful_child_calls.get(input.child_call_id);
  if (!rec || rec.worker_id !== input.worker_id || !rec.classifier_ok) {
    return { shape: EVIDENCE_SHAPE_WORKER_POLL, ok: false, reason: "child_call_not_successful_for_worker" };
  }
  if (!input.exposed_citation_ids.includes(input.child_call_id)) {
    return { shape: EVIDENCE_SHAPE_WORKER_POLL, ok: false, reason: "citation_not_on_exposed_page" };
  }
  if (!input.poll_call_id) {
    return { shape: EVIDENCE_SHAPE_WORKER_POLL, ok: false, reason: "missing_poll_call_id" };
  }
  return { shape: EVIDENCE_SHAPE_WORKER_POLL, ok: true };
}

export interface EvidenceValidatorLike {
  register(shape: number, fn: (input: Shape3Input) => Shape3Result): void;
}

export function registerWorkerEvidenceShape3(validator: EvidenceValidatorLike): void {
  validator.register(EVIDENCE_SHAPE_WORKER_POLL, validateWorkerEvidenceShape3);
}
