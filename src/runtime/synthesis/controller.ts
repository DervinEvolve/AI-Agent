import {
  buildSynthesisFeedback,
  computeDigest,
  truncateUtf8,
  wrapCheckWithHostHarness,
} from './harness';
import {
  SYNTHESIS_REASON_CODES,
  SynthesisCheckOutcome,
  SynthesisCheckResult,
  SynthesisCheckSpec,
  SynthesisFeedback,
  SynthesisModelOutput,
  SynthesisUsage,
  TEST_SYNTHESIS_CAPS,
  TestSynthesisConfig,
  TestSynthesisRecord,
} from './types';

export interface SynthesisBudgetPort {
  reserveSynthesisAttempt(attemptShare: number): boolean;
  releaseSynthesisAttempt(): void;
  reserveCheckStepsAndDeadline(steps: number, deadlineMs: number): boolean;
  releaseCheckReserve(): void;
  hasActiveBlocker(): boolean;
}

export interface SynthesisToolDispatchRequest {
  tool: 'run_code';
  call_id: string;
  origin: 'synthesis';
  code: string;
  timeoutMs: number;
  readOnlyWorkspace: true;
}

export interface SynthesisToolDispatchResponse {
  exitCode?: number;
  output: string;
  blockedBy?: 'approval_denied' | 'hook_denied' | 'taint_denied';
  unknownOutcome?: boolean;
  cleanup_confirmed?: boolean;
  durationMs: number;
}

export type SynthesisToolDispatcher = (
  req: SynthesisToolDispatchRequest,
) => Promise<SynthesisToolDispatchResponse>;

export interface SynthesisInferenceResult {
  rawText: string;
  hasToolCalls?: boolean;
  usage?: SynthesisUsage;
  usageUnknown?: boolean;
}

export type SynthesisInferencePort = (
  candidate: string,
  instructionDigest: string,
) => Promise<SynthesisInferenceResult>;

export type SynthesisPhaseDecision =
  | { action: 'proceed_to_finalizer'; record: TestSynthesisRecord; warning?: string }
  | { action: 'reconcile'; record: TestSynthesisRecord; feedback: SynthesisFeedback }
  | { action: 'publish_incomplete'; record: TestSynthesisRecord; reason: string };

export class TestSynthesisController {
  private round = 0;
  private lastFailedChecks: SynthesisCheckSpec[] = [];
  private lastCandidateDigest: string | null = null;
  private readonly instructionDigest = computeDigest('runtime:test-synthesis:v1');
  private callCounter = 0;

  constructor(
    private readonly runId: string,
    private readonly config: Readonly<TestSynthesisConfig>,
    private readonly budget: SynthesisBudgetPort,
    private readonly dispatchTool: SynthesisToolDispatcher,
    private readonly inferChecks: SynthesisInferencePort,
  ) {}

  async onCandidateFinalAnswer(candidate: string): Promise<SynthesisPhaseDecision> {
    const candidateDigest = computeDigest(candidate);

    if (this.round > 0 && this.lastCandidateDigest === candidateDigest) {
      return this.applyUnreconciledPolicy(candidateDigest, 0, 0, 0, 0);
    }

    if (this.budget.hasActiveBlocker()) {
      const record = this.makeRecord(candidateDigest, 0, 0, 0, 0, SYNTHESIS_REASON_CODES.SKIPPED);
      return { action: 'proceed_to_finalizer', record };
    }

    const isRecheck = this.round > 0 && this.lastFailedChecks.length > 0;
    let checksToRun: SynthesisCheckSpec[] = [];
    let usage: SynthesisUsage | undefined;

    if (isRecheck) {
      checksToRun = [...this.lastFailedChecks];
    } else {
      const reserved = this.budget.reserveSynthesisAttempt(this.config.attemptShare);
      if (!reserved) {
        const record = this.makeRecord(candidateDigest, 0, 0, 0, 0, SYNTHESIS_REASON_CODES.SKIPPED);
        return { action: 'proceed_to_finalizer', record };
      }

      let inf: SynthesisInferenceResult;
      try {
        inf = await this.inferChecks(candidate, this.instructionDigest);
      } finally {
        this.budget.releaseSynthesisAttempt();
      }

      if (inf.usageUnknown) {
        const record = this.makeRecord(
          candidateDigest,
          0,
          0,
          0,
          0,
          SYNTHESIS_REASON_CODES.USAGE_UNKNOWN,
        );
        return {
          action: 'publish_incomplete',
          record,
          reason: SYNTHESIS_REASON_CODES.USAGE_UNKNOWN,
        };
      }
      usage = inf.usage;

      const parsed = this.parseAndValidateChecks(inf);
      if (!parsed) {
        const record = this.makeRecord(
          candidateDigest,
          0,
          0,
          0,
          0,
          SYNTHESIS_REASON_CODES.REJECTED,
          usage,
        );
        return { action: 'proceed_to_finalizer', record };
      }
      checksToRun = parsed;
    }

    const results: SynthesisCheckResult[] = [];
    let blocked = false;
    let unknownCheck = false;

    for (const spec of checksToRun) {
      const callId = `synth_${this.runId}_${++this.callCounter}`;
      const wrappedCode = wrapCheckWithHostHarness(
        candidate,
        spec.code,
        this.config.assertionExitCode,
      );
      const resp = await this.dispatchTool({
        tool: 'run_code',
        call_id: callId,
        origin: 'synthesis',
        code: wrappedCode,
        timeoutMs: this.config.checkTimeoutMs,
        readOnlyWorkspace: true,
      });

      const capped = truncateUtf8(resp.output, this.config.maxCheckOutputBytes);
      let outcome: SynthesisCheckOutcome;
      if (resp.unknownOutcome || resp.cleanup_confirmed === false) {
        outcome = 'unknown';
        unknownCheck = true;
      } else if (resp.blockedBy) {
        outcome = 'blocked';
        blocked = true;
      } else if (resp.exitCode === 0) {
        outcome = 'pass';
      } else if (resp.exitCode === this.config.assertionExitCode) {
        outcome = 'check_failed';
      } else {
        outcome = 'check_error';
      }

      results.push({
        id: spec.id,
        kind: spec.kind,
        call_id: callId,
        origin: 'synthesis',
        outcome,
        exitCode: resp.exitCode,
        output: capped.text,
        truncated: capped.truncated,
        durationMs: resp.durationMs,
        citable: false,
      });

      if (blocked || unknownCheck) {
        break;
      }
    }

    if (unknownCheck) {
      const record = this.makeRecord(
        candidateDigest,
        results.length,
        results.filter((r) => r.outcome === 'pass').length,
        results.filter((r) => r.outcome === 'check_failed').length,
        results.filter((r) => r.outcome === 'check_error').length,
        SYNTHESIS_REASON_CODES.CHECK_UNKNOWN,
        usage,
      );
      return {
        action: 'publish_incomplete',
        record,
        reason: SYNTHESIS_REASON_CODES.CHECK_UNKNOWN,
      };
    }

    const passed = results.filter((r) => r.outcome === 'pass').length;
    const failedResults = results.filter((r) => r.outcome === 'check_failed');
    const errored = results.filter((r) => r.outcome === 'check_error').length;

    if (blocked && failedResults.length === 0) {
      const record = this.makeRecord(
        candidateDigest,
        results.length,
        passed,
        0,
        errored,
        SYNTHESIS_REASON_CODES.BLOCKED,
        usage,
      );
      return { action: 'proceed_to_finalizer', record };
    }

    if (failedResults.length === 0) {
      const outcome =
        passed > 0 ? SYNTHESIS_REASON_CODES.PASSED : SYNTHESIS_REASON_CODES.INCONCLUSIVE;
      const record = this.makeRecord(
        candidateDigest,
        results.length,
        passed,
        0,
        errored,
        outcome,
        usage,
      );
      return { action: 'proceed_to_finalizer', record };
    }

    if (blocked && isRecheck) {
      return this.applyUnreconciledPolicy(
        candidateDigest,
        results.length,
        passed,
        failedResults.length,
        errored,
        usage,
      );
    }

    const canStartRound =
      this.round < this.config.maxSynthesisRounds &&
      !this.budget.hasActiveBlocker() &&
      this.budget.reserveCheckStepsAndDeadline(
        this.config.maxChecksPerRound + 1,
        this.config.maxChecksPerRound * this.config.checkTimeoutMs,
      );

    if (!canStartRound) {
      return this.applyUnreconciledPolicy(
        candidateDigest,
        results.length,
        passed,
        failedResults.length,
        errored,
        usage,
      );
    }

    this.round += 1;
    this.lastCandidateDigest = candidateDigest;
    this.lastFailedChecks = checksToRun.filter((spec) =>
      failedResults.some((r) => r.id === spec.id),
    );

    const feedback = buildSynthesisFeedback(
      this.round,
      failedResults.map((r) => {
        const spec = checksToRun.find((s) => s.id === r.id)!;
        return { id: r.id, hypothesis: spec.hypothesis, result: r };
      }),
      this.config.maxFeedbackBytes,
    );

    const record = this.makeRecord(
      candidateDigest,
      results.length,
      passed,
      failedResults.length,
      errored,
      SYNTHESIS_REASON_CODES.CHECKS_FAILED,
      usage,
    );
    return { action: 'reconcile', record, feedback };
  }

  onRoundEndedWithoutCandidate(): SynthesisPhaseDecision {
    this.budget.releaseCheckReserve();
    const record = this.makeRecord(
      this.lastCandidateDigest ?? '',
      0,
      0,
      0,
      0,
      SYNTHESIS_REASON_CODES.NO_CANDIDATE,
    );
    return {
      action: 'publish_incomplete',
      record,
      reason: SYNTHESIS_REASON_CODES.NO_CANDIDATE,
    };
  }

  private applyUnreconciledPolicy(
    candidateDigest: string,
    checksRun: number,
    passed: number,
    failed: number,
    errored: number,
    usage?: SynthesisUsage,
  ): SynthesisPhaseDecision {
    if (this.config.unreconciledPolicy === 'warn') {
      const record = this.makeRecord(
        candidateDigest,
        checksRun,
        passed,
        failed,
        errored,
        SYNTHESIS_REASON_CODES.CHECKS_FAILED_WARN,
        usage,
      );
      return {
        action: 'proceed_to_finalizer',
        record,
        warning: SYNTHESIS_REASON_CODES.CHECKS_FAILED_WARN,
      };
    }
    const record = this.makeRecord(
      candidateDigest,
      checksRun,
      passed,
      failed,
      errored,
      SYNTHESIS_REASON_CODES.CHECKS_FAILED,
      usage,
    );
    return {
      action: 'publish_incomplete',
      record,
      reason: SYNTHESIS_REASON_CODES.CHECKS_FAILED,
    };
  }

  private parseAndValidateChecks(inf: SynthesisInferenceResult): SynthesisCheckSpec[] | null {
    if (inf.hasToolCalls) return null;
    if (Buffer.byteLength(inf.rawText, 'utf8') > this.config.maxCheckBytes) return null;
    let parsed: SynthesisModelOutput;
    try {
      parsed = JSON.parse(inf.rawText) as SynthesisModelOutput;
    } catch {
      return null;
    }
    if (!parsed || !Array.isArray(parsed.checks) || parsed.checks.length === 0) {
      return null;
    }
    if (parsed.checks.length > this.config.maxChecksPerRound) {
      return null;
    }
    if (
      parsed.rationale !== undefined &&
      (typeof parsed.rationale !== 'string' ||
        Buffer.byteLength(parsed.rationale, 'utf8') > TEST_SYNTHESIS_CAPS.maxRationaleBytes)
    ) {
      return null;
    }
    for (const c of parsed.checks) {
      if (
        !c ||
        typeof c.id !== 'string' ||
        (c.kind !== 'property' && c.kind !== 'differential') ||
        typeof c.hypothesis !== 'string' ||
        Buffer.byteLength(c.hypothesis, 'utf8') > TEST_SYNTHESIS_CAPS.maxHypothesisBytes ||
        typeof c.code !== 'string' ||
        c.code.length === 0
      ) {
        return null;
      }
    }
    return parsed.checks;
  }

  private makeRecord(
    candidateDigest: string,
    checksRun: number,
    passed: number,
    failed: number,
    errored: number,
    outcome: TestSynthesisRecord['outcome'],
    usage?: SynthesisUsage,
  ): TestSynthesisRecord {
    return {
      run_id: this.runId,
      round: this.round,
      candidate_digest: candidateDigest,
      checks_run: checksRun,
      passed,
      failed,
      errored,
      outcome,
      usage,
      instruction_digest: this.instructionDigest,
    };
  }
}
