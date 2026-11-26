import { createServer, type Server, type AddressInfo } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  computeRecordDigest,
  computeSuiteDigest,
  createSupportChecker,
  normalizePairHash,
  parseSupportLabel,
  qualify,
  QUALIFICATION_REASON_CODES,
  verifyQualificationRecord,
  type QualificationConfig,
  type QualificationPair,
  type QualificationSuite,
  type SupportChecker,
} from '../types';

function makeSuite(): QualificationSuite {
  const pairs: QualificationPair[] = [];
  const add = (
    category: QualificationPair['category'],
    gold: QualificationPair['gold'],
    id: string,
  ) => {
    pairs.push({
      id,
      premise: `premise ${id}`,
      claim: `claim ${id}`,
      category,
      gold,
    });
  };

  for (let i = 1; i <= 5; i += 1) add('supported', 'supported', `s${i}`);
  for (let i = 1; i <= 4; i += 1) add('contradicted', 'contradicted', `c${i}`);
  for (let i = 1; i <= 4; i += 1) add('insufficient', 'insufficient', `i${i}`);
  add('compound', 'supported', 'compound1');
  add('instruction-bearing', 'contradicted', 'instr1');

  return { pairs };
}

function makeConfig(
  suite: QualificationSuite,
  overrides: Partial<QualificationConfig> = {},
): QualificationConfig {
  return {
    endpoint_origin: 'http://127.0.0.1:9',
    model_id: 'checker-model',
    adapter_id: 'checker-adapter',
    system_prompt_digest: 'sha256:test-prompt',
    parser_version: '1.0.0',
    resolver_version: '1.0.0',
    suite_digest: computeSuiteDigest(suite),
    thresholds: {
      false_accept_rate: 0.2,
      false_reject_rate: 0.2,
      error_rate: 0.1,
    },
    training_set_hashes: [],
    system_prompt:
      'You are a claim support checker. Reply with exactly one of: supported, contradicted, insufficient.',
    ...overrides,
  };
}

function fakeClient(
  behavior: (
    pair: QualificationPair,
  ) => { raw: string; error?: 'transport_error' } | null,
): SupportChecker {
  return {
    check: async (pair) => behavior(pair as QualificationPair),
  };
}

describe('qualification parser', () => {
  it('accepts exact labels after trimming surrounding whitespace only', () => {
    expect(parseSupportLabel(' supported ')).toBe('supported');
    expect(parseSupportLabel('contradicted\n')).toBe('contradicted');
    expect(parseSupportLabel('\tinsufficient\t')).toBe('insufficient');
  });

  it('rejects wrong case, punctuation, prose, missing content, and oversized responses', () => {
    expect(parseSupportLabel('Supported')).toBe('checker_error');
    expect(parseSupportLabel('supported.')).toBe('checker_error');
    expect(parseSupportLabel('I think it is supported')).toBe('checker_error');
    expect(parseSupportLabel('')).toBe('checker_error');
    expect(parseSupportLabel('supported'.padEnd(65, 'x'))).toBe('checker_error');
  });
});

describe('qualify suite validation and leakage check', () => {
  it('refuses to run on a suite with fewer than 15 pairs', async () => {
    const suite = { pairs: makeSuite().pairs.slice(0, 14) };
    const config = makeConfig(suite);
    const client = { check: vi.fn() } as unknown as SupportChecker;

    const record = await qualify(suite, config, client);

    expect(record.status).toBe('blocked');
    expect(record.reason_code).toBe(QUALIFICATION_REASON_CODES.SUITE_TOO_SMALL);
    expect(record.false_accept_rate).toBeNull();
    expect(client.check).not.toHaveBeenCalled();
  });

  it('refuses to run when a required category is missing', async () => {
    const base = makeSuite().pairs.filter((pair) => pair.category !== 'compound');
    const suite: QualificationSuite = {
      pairs: [
        ...base,
        {
          id: 'extra',
          premise: 'extra premise',
          claim: 'extra claim',
          category: 'supported',
          gold: 'supported',
        },
      ],
    };
    const config = makeConfig(suite);
    const client = { check: vi.fn() } as unknown as SupportChecker;

    const record = await qualify(suite, config, client);

    expect(record.status).toBe('blocked');
    expect(record.reason_code).toBe(QUALIFICATION_REASON_CODES.MISSING_CATEGORY);
    expect(client.check).not.toHaveBeenCalled();
  });

  it('refuses to run on any overlap with the e68 training set', async () => {
    const suite = makeSuite();
    const overlappingHash = normalizePairHash(
      suite.pairs[0].premise,
      suite.pairs[0].claim,
    );
    const config = makeConfig(suite, {
      training_set_hashes: [overlappingHash],
    });
    const client = { check: vi.fn() } as unknown as SupportChecker;

    const record = await qualify(suite, config, client);

    expect(record.status).toBe('blocked');
    expect(record.reason_code).toBe(QUALIFICATION_REASON_CODES.TRAINING_OVERLAP);
    expect(record.overlap_count).toBe(1);
    expect(client.check).not.toHaveBeenCalled();
  });
});

describe('qualify scoring', () => {
  it('passes a checker that returns the correct gold label for every pair', async () => {
    const suite = makeSuite();
    const config = makeConfig(suite);
    const client = fakeClient((pair) => ({ raw: pair.gold }));

    const record = await qualify(suite, config, client);

    expect(record.status).toBe('pass');
    expect(record.pass).toBe(true);
    expect(record.reason_code).toBe(QUALIFICATION_REASON_CODES.PASS);
    expect(record.false_accept_rate).toBe(0);
    expect(record.false_reject_rate).toBe(0);
    expect(record.error_rate).toBe(0);
    expect(record.completed_pairs).toBe(15);
    expect(record.total_pairs).toBe(15);
  });

  it('fails an all-one-label checker on the trivial-baseline guard', async () => {
    const suite = makeSuite();
    const config = makeConfig(suite);
    const client = fakeClient(() => ({ raw: 'supported' }));

    const record = await qualify(suite, config, client);

    expect(record.status).toBe('fail');
    expect(record.pass).toBe(false);
    expect(record.reason_code).toBe(
      QUALIFICATION_REASON_CODES.TRIVIAL_BASELINE_FAIL,
    );
    expect(record.false_accept_rate).not.toBeNull();
  });

  it('counts parser errors and allows a single parser error within threshold', async () => {
    const suite = makeSuite();
    const config = makeConfig(suite);
    const client = fakeClient((pair) =>
      pair.id === 's1' ? { raw: 'supported.' } : { raw: pair.gold },
    );

    const record = await qualify(suite, config, client);

    expect(record.status).toBe('pass');
    expect(record.error_rate).toBeCloseTo(1 / 15);
    expect(record.confusion.error.supported).toBe(1);
  });

  it('fails when error rate exceeds frozen threshold', async () => {
    const suite = makeSuite();
    const config = makeConfig(suite);
    const client = fakeClient((pair) =>
      pair.id === 's1' || pair.id === 's2'
        ? { raw: 'supported.' }
        : { raw: pair.gold },
    );

    const record = await qualify(suite, config, client);

    expect(record.status).toBe('fail');
    expect(record.reason_code).toBe(QUALIFICATION_REASON_CODES.THRESHOLD_FAIL);
    expect(record.error_rate).toBeCloseTo(2 / 15);
  });

  it('returns partial with no rates when any pair is missing', async () => {
    const suite = makeSuite();
    const config = makeConfig(suite);
    const client = fakeClient((pair) =>
      pair.id === 's1' ? null : { raw: pair.gold },
    );

    const record = await qualify(suite, config, client);

    expect(record.status).toBe('partial');
    expect(record.pass).toBe(false);
    expect(record.reason_code).toBe(QUALIFICATION_REASON_CODES.INCOMPLETE_RUN);
    expect(record.false_accept_rate).toBeNull();
    expect(record.false_reject_rate).toBeNull();
    expect(record.error_rate).toBeNull();
    expect(record.completed_pairs).toBe(14);
  });
});

describe('startup qualification verification', () => {
  it('accepts a matching recorded pass from a non-localhost origin', async () => {
    const suite = makeSuite();
    const config = makeConfig(suite, {
      endpoint_origin: 'https://checker.example.com',
    });
    const client = fakeClient((pair) => ({ raw: pair.gold }));
    const record = await qualify(suite, config, client);

    const result = verifyQualificationRecord(record, {
      endpoint_origin: 'https://checker.example.com',
      model_id: config.model_id,
      adapter_id: config.adapter_id,
      system_prompt_digest: config.system_prompt_digest,
      parser_version: config.parser_version,
      resolver_version: config.resolver_version,
      suite_digest: config.suite_digest,
      thresholds: config.thresholds,
    });

    expect(result.ok).toBe(true);
    expect(result.reason_code).toBe(QUALIFICATION_REASON_CODES.PASS);
  });

  it('rejects localhost/scripted fixtures for production startup', async () => {
    const suite = makeSuite();
    const config = makeConfig(suite, {
      endpoint_origin: 'https://checker.example.com',
    });
    const client = fakeClient((pair) => ({ raw: pair.gold }));
    const record = await qualify(suite, config, client);

    const result = verifyQualificationRecord(record, {
      endpoint_origin: 'http://127.0.0.1:9',
      model_id: config.model_id,
      adapter_id: config.adapter_id,
      system_prompt_digest: config.system_prompt_digest,
      parser_version: config.parser_version,
      resolver_version: config.resolver_version,
      suite_digest: config.suite_digest,
      thresholds: config.thresholds,
    });

    expect(result.ok).toBe(false);
    expect(result.reason_code).toBe(QUALIFICATION_REASON_CODES.SCRIPTED_FIXTURE);
  });

  it('rejects missing records', () => {
    const result = verifyQualificationRecord(null, {
      endpoint_origin: 'https://checker.example.com',
      model_id: 'checker-model',
      adapter_id: 'checker-adapter',
      system_prompt_digest: 'sha256:test-prompt',
      parser_version: '1.0.0',
      resolver_version: '1.0.0',
      suite_digest: 'sha256:suite',
      thresholds: {
        false_accept_rate: 0.2,
        false_reject_rate: 0.2,
        error_rate: 0.1,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.reason_code).toBe(QUALIFICATION_REASON_CODES.MISSING_RECORD);
  });

  it('rejects digest mismatch', async () => {
    const suite = makeSuite();
    const config = makeConfig(suite, {
      endpoint_origin: 'https://checker.example.com',
    });
    const client = fakeClient((pair) => ({ raw: pair.gold }));
    const record = await qualify(suite, config, client);
    const tampered = { ...record, model_id: 'tampered-model' };

    const result = verifyQualificationRecord(tampered, {
      endpoint_origin: 'https://checker.example.com',
      model_id: config.model_id,
      adapter_id: config.adapter_id,
      system_prompt_digest: config.system_prompt_digest,
      parser_version: config.parser_version,
      resolver_version: config.resolver_version,
      suite_digest: config.suite_digest,
      thresholds: config.thresholds,
    });

    expect(result.ok).toBe(false);
    expect(result.reason_code).toBe(QUALIFICATION_REASON_CODES.DIGEST_MISMATCH);
  });

  it('rejects origin/model/adapter mismatches', async () => {
    const suite = makeSuite();
    const config = makeConfig(suite, {
      endpoint_origin: 'https://checker.example.com',
    });
    const client = fakeClient((pair) => ({ raw: pair.gold }));
    const record = await qualify(suite, config, client);
    const expected = {
      endpoint_origin: 'https://checker.example.com',
      model_id: config.model_id,
      adapter_id: config.adapter_id,
      system_prompt_digest: config.system_prompt_digest,
      parser_version: config.parser_version,
      resolver_version: config.resolver_version,
      suite_digest: config.suite_digest,
      thresholds: config.thresholds,
    };

    const wrongOriginBase = {
      ...record,
      endpoint_origin: 'https://other.example.com',
    };
    const wrongOrigin = {
      ...wrongOriginBase,
      record_digest: computeRecordDigest(wrongOriginBase),
    };
    expect(verifyQualificationRecord(wrongOrigin, expected).reason_code).toBe(
      QUALIFICATION_REASON_CODES.ORIGIN_MISMATCH,
    );

    const wrongModelBase = { ...record, model_id: 'other-model' };
    const wrongModel = {
      ...wrongModelBase,
      record_digest: computeRecordDigest(wrongModelBase),
    };
    expect(verifyQualificationRecord(wrongModel, expected).reason_code).toBe(
      QUALIFICATION_REASON_CODES.MODEL_MISMATCH,
    );

    const wrongAdapterBase = { ...record, adapter_id: 'other-adapter' };
    const wrongAdapter = {
      ...wrongAdapterBase,
      record_digest: computeRecordDigest(wrongAdapterBase),
    };
    expect(verifyQualificationRecord(wrongAdapter, expected).reason_code).toBe(
      QUALIFICATION_REASON_CODES.ADAPTER_MISMATCH,
    );
  });

  it('rejects expired records', async () => {
    const suite = makeSuite();
    const config = makeConfig(suite, {
      endpoint_origin: 'https://checker.example.com',
    });
    const client = fakeClient((pair) => ({ raw: pair.gold }));
    const record = await qualify(suite, config, client);
    const expiredBase = {
      ...record,
      timestamp: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const expired = {
      ...expiredBase,
      record_digest: computeRecordDigest(expiredBase),
    };

    const result = verifyQualificationRecord(expired, {
      endpoint_origin: 'https://checker.example.com',
      model_id: config.model_id,
      adapter_id: config.adapter_id,
      system_prompt_digest: config.system_prompt_digest,
      parser_version: config.parser_version,
      resolver_version: config.resolver_version,
      suite_digest: config.suite_digest,
      thresholds: config.thresholds,
    }, {
      max_age_ms: 7 * 24 * 60 * 60 * 1000,
    });

    expect(result.ok).toBe(false);
    expect(result.reason_code).toBe(QUALIFICATION_REASON_CODES.EXPIRED);
  });
});

describe('real OpenAI-compatible client', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [{ message: { content: 'supported' } }],
        }),
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('drives the real client against a localhost fixture and returns raw content', async () => {
    const checker = createSupportChecker({
      endpoint: baseUrl,
      model: 'checker',
      system_prompt: 'Reply with one label.',
    });

    const report = await checker.check({
      premise: 'premise',
      claim: 'claim',
    });

    expect(report).not.toBeNull();
    expect(report!.raw).toBe('supported');
  });
});
