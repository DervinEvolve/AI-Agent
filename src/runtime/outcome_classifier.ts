export type OutcomeClassification = 'success' | 'known_failure' | 'unknown';

export interface ToolResultLike {
  call_id?: string;
  toolName?: string;
  tool?: string;
  status: string;
  output?: unknown;
  error?: unknown;
  started?: boolean;
}

export type OutcomePredicate = (result: ToolResultLike) => OutcomeClassification;

export class OutcomeClassifier {
  private readonly predicates = new Map<string, OutcomePredicate>();

  registerPredicate(toolName: string, fn: OutcomePredicate): void {
    if (!toolName || typeof fn !== 'function') {
      throw new Error('registerPredicate requires a toolName and predicate function');
    }
    this.predicates.set(toolName, fn);
  }

  classify(result: ToolResultLike): OutcomeClassification {
    const toolName = result.toolName ?? result.tool;
    if (toolName && this.predicates.has(toolName)) {
      return this.predicates.get(toolName)!(result);
    }

    if (result.status === 'timeout' || result.status === 'unknown') {
      return 'unknown';
    }

    if (result.output !== null && typeof result.output === 'object' && 'ok' in result.output) {
      const okVal = (result.output as { ok?: unknown }).ok;
      if (okVal === false) {
        return 'known_failure';
      }
      if (okVal === true && result.status === 'ok') {
        return 'success';
      }
      return 'unknown';
    }

    if (result.status === 'ok') {
      return 'success';
    }
    if (result.status === 'error') {
      return 'known_failure';
    }
    return 'unknown';
  }
}
