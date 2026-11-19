import { describe, expect, it } from 'vitest';
import {
  BASELINE_TASK_IDS,
  baselineAdmissionFailures,
  createBlockedBaselineReport,
  serializeBlockedBaselineReport,
} from '../eval_baseline_blocked';
import type { BaselineAdmission } from '../eval_baseline_blocked';

const available = (): BaselineAdmission => ({
  mode: 'live',
  credential: 'test-secret-never-publish',
  harnessAvailable: true,
  adapterAvailable: true,
  wireFeaturesAvailable: true,
  directCitationsAvailable: true,
  exposureTrackingAvailable: true,
});

describe('baseline blocked admission reporting (not runtime evaluation)', () => {
  it('rejects missing and whitespace live credentials before transport exists', () => {
    for (const credential of [undefined, '', ' \n\t ']) {
      expect(baselineAdmissionFailures({ ...available(), credential }))
        .toEqual(['credentials_unavailable']);
    }
  });

  it('keeps six declared tasks and unknown metrics when the harness is unavailable', () => {
    const report = createBlockedBaselineReport({ ...available(), harnessAvailable: false })!;
    expect(report.tasks.map(task => task.task_id)).toEqual([...BASELINE_TASK_IDS]);
    expect(report.aggregation).toMatchObject({ passes: 0, denominator: 6, attempted: 0 });
    expect(report.score_available).toBe(false);
    expect(report.suite_sha256).toBeNull();
    for (const task of report.tasks) {
      expect(task.status).toBe('infrastructure_error');
      expect(task.model_calls).toBeNull();
      expect(task.runtime_outcome).toBeNull();
      expect(task.reported_usage_or_null).toBeNull();
      expect(task.usage_complete).toBe(false);
    }
  });

  it('does not substitute model failure for missing evidence interfaces', () => {
    expect(baselineAdmissionFailures({
      ...available(), directCitationsAvailable: false, exposureTrackingAvailable: false,
    })).toEqual(['validator_shape_unavailable', 'exposure_tracking_unavailable']);
  });

  it('does not publish credentials and bounds serialized bytes', () => {
    const input = { ...available(), harnessAvailable: false };
    const json = serializeBlockedBaselineReport(input)!;
    expect(json).not.toContain(input.credential);
    expect(/[^\x00-\x7f]/.test(json)).toBe(false);
    expect(json.length).toBeLessThanOrEqual(65536);
    expect(JSON.parse(json).execution).toBe('blocked');
  });

  it('never generates a score for an admitted configuration', () => {
    expect(createBlockedBaselineReport(available())).toBeNull();
    expect(serializeBlockedBaselineReport(available())).toBeNull();
  });

  it('does not require live secrets in localhost or scripted modes', () => {
    for (const mode of ['localhost_fixture', 'scripted'] as const) {
      expect(baselineAdmissionFailures({ ...available(), mode, credential: undefined })).toEqual([]);
    }
  });

  it('allocates separate diagnostic arrays for tasks and reports', () => {
    const input = { ...available(), harnessAvailable: false };
    const first = createBlockedBaselineReport(input)!;
    first.tasks[0].bounded_reason_codes.length = 0;
    expect(first.tasks[1].bounded_reason_codes).toEqual(['harness_unavailable']);
    expect(createBlockedBaselineReport(input)!.tasks[0].bounded_reason_codes)
      .toEqual(['harness_unavailable']);
  });
});
