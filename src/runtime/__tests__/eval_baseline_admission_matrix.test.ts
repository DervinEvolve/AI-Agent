import { describe, expect, it } from 'vitest';
import {
  baselineAdmissionFailures,
  createBlockedBaselineReport,
  serializeBlockedBaselineReport,
} from '../eval_baseline_blocked';
import type { BaselineAdmission, BlockedReason } from '../eval_baseline_blocked';

const gates = [
  ['harnessAvailable', 'harness_unavailable'],
  ['adapterAvailable', 'adapter_unavailable'],
  ['wireFeaturesAvailable', 'wire_features_unavailable'],
  ['directCitationsAvailable', 'validator_shape_unavailable'],
  ['exposureTrackingAvailable', 'exposure_tracking_unavailable'],
] as const;

const taskIds = [
  'arithmetic_evidence',
  'dependent_lookup',
  'known_failure_repair',
  'truncated_observation_recall',
  'untrusted_instruction',
  'bounded_absence',
];

describe('independent blocked-admission capability matrix', () => {
  it('accumulates every unavailable capability without turning admission into a score', () => {
    for (const mode of ['scripted', 'localhost_fixture', 'live'] as const) {
      for (const credential of [undefined, ' \t\n ', 'private-admission-token-98473']) {
        for (let mask = 0; mask < 32; mask++) {
          const input: BaselineAdmission = {
            mode,
            credential,
            harnessAvailable: true,
            adapterAvailable: true,
            wireFeaturesAvailable: true,
            directCitationsAvailable: true,
            exposureTrackingAvailable: true,
          };
          const expected: BlockedReason[] = [];
          gates.forEach(([field, reason], bit) => {
            input[field] = (mask & (1 << bit)) === 0;
            if (!input[field]) expected.push(reason);
          });
          if (mode === 'live' && !credential?.trim()) {
            expected.push('credentials_unavailable');
          }
          const before = { ...input };
          expect(baselineAdmissionFailures(input).slice().sort()).toEqual(expected.slice().sort());
          const report = createBlockedBaselineReport(input);
          const serialized = serializeBlockedBaselineReport(input);
          expect(input).toEqual(before);

          if (expected.length === 0) {
            // Admission is not execution: no fabricated passing report.
            expect(report).toBeNull();
            expect(serialized).toBeNull();
            continue;
          }

          expect(report).not.toBeNull();
          if (!report || serialized === null) throw new Error('Blocked admission omitted its report');
          expect(JSON.parse(serialized)).toEqual(report);
          expect(serialized).not.toContain('private-admission-token-98473');
          expect(report.execution).toBe('blocked');
          expect(report.score_available).toBe(false);
          expect(report.actual_cost).toBeNull();
          expect(report.mode).toBe(mode);
          expect(report.provider_model_if_live).toBe(mode === 'live' ? 'google/gemini-3.8-flash' : null);
          expect(report.aggregation).toMatchObject({ passes: 0, denominator: 6, attempted: 0 });
          expect(report.tasks.map(task => task.task_id)).toEqual(taskIds);
          for (const task of report.tasks) {
            expect(task.contract_verdict).toBe('unverifiable');
            expect(task.status).toBe('infrastructure_error');
            expect(task.runtime_outcome).toBeNull();
            expect(task.dispatch_attempts).toBeNull();
            expect(task.decode_rejects).toBeNull();
            expect(task.model_calls).toBeNull();
            expect(task.elapsed_ms).toBeNull();
            expect(task.reported_usage_or_null).toBeNull();
            expect(task.usage_complete).toBe(false);
          }
        }
      }
    }
  });
});
