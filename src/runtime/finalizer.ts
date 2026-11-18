import type { Citation } from './action_decoder';
import { EvidenceValidator, type RunStateForValidation } from './evidence_validator';
import type { UnresolvedItem } from './recovery_ledger';

export interface TaskContract {
  criteria: Array<
    | { type: 'tool_result'; call_id?: string; toolName?: string }
    | { type: 'answer_predicate'; predicate: (answer: string) => boolean }
  >;
}

export interface RunStateForFinalizer extends RunStateForValidation {
  unresolved: UnresolvedItem[];
  toolOutputsByCallId: Map<string, { toolName: string; status: string; output: unknown }>;
}

export interface FinalizeResult {
  published: 'completion' | 'incomplete';
  reasons: string[];
  verification: 'pass' | 'fail' | 'unverifiable' | 'not_configured';
}

export class Finalizer {
  private readonly validator = new EvidenceValidator();

  finalize(
    candidateAnswer: string,
    citations: Citation[] | undefined,
    runState: RunStateForFinalizer,
    contract?: TaskContract,
    claimsNoToolEvidence = false,
  ): FinalizeResult {
    const reasons: string[] = [];
    let verification: FinalizeResult['verification'] = 'not_configured';

    if (contract !== undefined) {
      if (
        contract === null ||
        typeof contract !== 'object' ||
        !Array.isArray(contract.criteria) ||
        contract.criteria.length === 0
      ) {
        reasons.push('infrastructure_error');
        return { published: 'incomplete', reasons, verification: 'not_configured' };
      }

      let allPassed = true;
      for (const criterion of contract.criteria) {
        if (criterion.type === 'tool_result') {
          if (criterion.call_id) {
            const obs = runState.observations.get(criterion.call_id);
            if (!obs || obs.classification !== 'success') {
              allPassed = false;
              reasons.push(`contract_tool_result_failed:${criterion.call_id}`);
            }
          } else if (criterion.toolName) {
            const matched = Array.from(runState.toolOutputsByCallId.entries()).some(
              ([callId, info]) =>
                info.toolName === criterion.toolName &&
                runState.observations.get(callId)?.classification === 'success',
            );
            if (!matched) {
              allPassed = false;
              reasons.push(`contract_tool_result_failed:${criterion.toolName}`);
            }
          } else {
            allPassed = false;
            reasons.push('infrastructure_error');
            return { published: 'incomplete', reasons, verification: 'not_configured' };
          }
        } else if (criterion.type === 'answer_predicate') {
          if (typeof criterion.predicate !== 'function') {
            reasons.push('infrastructure_error');
            return { published: 'incomplete', reasons, verification: 'not_configured' };
          }
          if (!criterion.predicate(candidateAnswer)) {
            allPassed = false;
            reasons.push('contract_answer_predicate_failed');
          }
        } else {
          reasons.push('infrastructure_error');
          return { published: 'incomplete', reasons, verification: 'not_configured' };
        }
      }
      verification = allPassed ? 'pass' : 'fail';
      if (!allPassed) {
        return { published: 'incomplete', reasons, verification };
      }
    }

    if (!claimsNoToolEvidence) {
      const evidence = this.validator.validate(citations, runState);
      if (!evidence.ok) {
        reasons.push(...evidence.reasons);
        return { published: 'incomplete', reasons, verification };
      }
    }

    if (runState.unresolved.length > 0 && !claimsNoToolEvidence) {
      reasons.push('unresolved_unknown_outcomes');
      return { published: 'incomplete', reasons, verification };
    }

    return { published: 'completion', reasons, verification };
  }
}
