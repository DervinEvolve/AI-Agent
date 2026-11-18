import type { Citation } from './action_decoder';
import type { OutcomeClassification } from './outcome_classifier';

export interface ObservedRecord {
  call_id: string;
  started: boolean;
  classification: OutcomeClassification;
}

export interface RunStateForValidation {
  observations: Map<string, ObservedRecord>;
}

export class EvidenceValidator {
  validate(
    citations: Citation[] | undefined,
    runState: RunStateForValidation,
  ): { ok: boolean; reasons: string[] } {
    if (!citations || citations.length === 0) {
      return { ok: false, reasons: ['no_citations'] };
    }

    const reasons: string[] = [];
    for (const citation of citations) {
      const shape = citation.shape ?? 1;
      if (shape !== 1) {
        reasons.push('shape_unavailable');
        continue;
      }
      if (!citation.call_id) {
        reasons.push('missing_call_id');
        continue;
      }
      const obs = runState.observations.get(citation.call_id);
      if (!obs) {
        reasons.push(`nonexistent_call_id:${citation.call_id}`);
        continue;
      }
      if (!obs.started) {
        reasons.push(`non_started_call_id:${citation.call_id}`);
        continue;
      }
      if (obs.classification !== 'success') {
        reasons.push(`unsuccessful_call_id:${citation.call_id}`);
      }
    }

    return { ok: reasons.length === 0, reasons };
  }
}
