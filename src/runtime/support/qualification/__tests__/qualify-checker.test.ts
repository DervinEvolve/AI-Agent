import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runQualifyCheckerCli } from '../qualify-checker';
import {
  computeSuiteDigest,
  QUALIFICATION_REASON_CODES,
  type QualificationConfig,
  type QualificationPair,
  type QualificationSuite,
  type SupportLabel,
} from '../types';

function makeSuite(): QualificationSuite {
  const pairs: QualificationPair[] = [];
  const add = (
    category: QualificationPair['category'],
    gold: SupportLabel,
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
  endpoint: string,
  overrides: Partial<QualificationConfig> = {},
): QualificationConfig {
  return {
    endpoint_origin: endpoint,
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

async function writeTempJson(
  dir: string,
  filename: string,
  data: unknown,
): Promise<string> {
  const path = join(dir, filename);
  await writeFile(path, JSON.stringify(data, null, 2), 'utf8');
  return path;
}

function startLabelServer(
  labelMap: Map<string, SupportLabel | 'error'>,
): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.end();
        return;
      }

      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as {
            messages?: Array<{ role: string; content: string }>;
          };
          const userMsg = parsed.messages?.find((m) => m.role === 'user');
          if (!userMsg) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'no user message' }));
            return;
          }

          const content = userMsg.content;
          const premiseMatch = content.match(/premise\s+(\S+)/);
          if (!premiseMatch) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'no premise found' }));
            return;
          }
          const id = premiseMatch[1];
          const label = labelMap.get(id);
          if (label === undefined) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: `unknown id ${id}` }));
            return;
          }

          const responseContent =
            label === 'error' ? 'unexpected response' : label;
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: responseContent,
                  },
                },
              ],
            }),
          );
        } catch {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'internal' }));
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        resolve({
          server,
          port,
          close: () =>
            new Promise((resClose) => {
              server.close(() => resClose());
            }),
        });
      } else {
        throw new Error('Failed to get server address');
      }
    });
  });
}

describe('qualify-checker CLI', () => {
  let tempDir: string;
  let server: Server;
  let port: number;
  let closeServer: () => Promise<void>;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'qualify-checker-test-'));
    const suite = makeSuite();
    const labelMap = new Map<string, SupportLabel | 'error'>();
    for (const pair of suite.pairs) {
      labelMap.set(pair.id, pair.gold);
    }
    const serverInfo = await startLabelServer(labelMap);
    server = serverInfo.server;
    port = serverInfo.port;
    closeServer = serverInfo.close;
  });

  afterAll(async () => {
    await closeServer();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('drives real client, parses exact labels, writes full record with pass=true', async () => {
    const suite = makeSuite();
    const endpoint = `http://127.0.0.1:${port}`;
    const config = makeConfig(suite, endpoint);

    const suitePath = await writeTempJson(tempDir, 'suite-pass.json', suite);
    const configPath = await writeTempJson(tempDir, 'config-pass.json', config);
    const outputPath = join(tempDir, 'record-pass.json');

    const exitCode = await runQualifyCheckerCli([
      suitePath,
      configPath,
      outputPath,
    ]);

    expect(exitCode).toBe(0);
    const record = JSON.parse(await readFile(outputPath, 'utf8'));

    expect(record.pass).toBe(true);
    expect(record.reason).toBe(QUALIFICATION_REASON_CODES.PASS);
    expect(record.thresholds).toEqual(config.thresholds);

    // Confusion matrix: all predictions match gold.
    expect(record.confusion.supported.supported).toBe(6); // 5 supported + 1 compound
    expect(record.confusion.contradicted.contradicted).toBe(5); // 4 contradicted + 1 instruction-bearing
    expect(record.confusion.insufficient.insufficient).toBe(4);
    expect(record.confusion.error.supported).toBe(0);
    expect(record.confusion.error.contradicted).toBe(0);
    expect(record.confusion.error.insufficient).toBe(0);

    expect(record.false_accept_rate).toBe(0);
    expect(record.false_reject_rate).toBe(0);
    expect(record.error_rate).toBe(0);
  });

  it('rejects suite with fewer than 15 pairs with suite_too_small', async () => {
    const smallSuite: QualificationSuite = {
      pairs: makeSuite().pairs.slice(0, 10), // 10 pairs, missing categories
    };
    const endpoint = `http://127.0.0.1:${port}`;
    const config = makeConfig(smallSuite, endpoint);

    const suitePath = await writeTempJson(
      tempDir,
      'suite-small.json',
      smallSuite,
    );
    const configPath = await writeTempJson(
      tempDir,
      'config-small.json',
      config,
    );
    const outputPath = join(tempDir, 'record-small.json');

    const exitCode = await runQualifyCheckerCli([
      suitePath,
      configPath,
      outputPath,
    ]);

    expect(exitCode).toBe(1);
    const record = JSON.parse(await readFile(outputPath, 'utf8'));
    expect(record.pass).toBe(false);
    expect(record.reason).toBe(QUALIFICATION_REASON_CODES.SUITE_TOO_SMALL);
  });

  it('detects training overlap and fails qualification', async () => {
    const suite = makeSuite();
    const endpoint = `http://127.0.0.1:${port}`;
    const overlappingHash = 'sha256:overlap';
    const config = makeConfig(suite, endpoint, {
      training_set_hashes: [overlappingHash],
    });

    const suitePath = await writeTempJson(
      tempDir,
      'suite-overlap.json',
      suite,
    );
    const configPath = await writeTempJson(
      tempDir,
      'config-overlap.json',
      config,
    );
    const outputPath = join(tempDir, 'record-overlap.json');

    const exitCode = await runQualifyCheckerCli([
      suitePath,
      configPath,
      outputPath,
    ]);

    expect(exitCode).toBe(1);
    const record = JSON.parse(await readFile(outputPath, 'utf8'));
    expect(record.pass).toBe(false);
    expect(record.reason).toBe(QUALIFICATION_REASON_CODES.TRAINING_OVERLAP);
  });

  it('counts trailing punctuation as checker_error but still passes if under threshold', async () => {
    const suite = makeSuite();
    // Override one pair's label to include trailing punctuation.
    const targetId = 's1';
    const labelMap = new Map<string, SupportLabel | 'error'>();
    for (const pair of suite.pairs) {
      if (pair.id === targetId) {
        labelMap.set(pair.id, 'error'); // server will return 'unexpected response'
      } else {
        labelMap.set(pair.id, pair.gold);
      }
    }

    const tempServerInfo = await startLabelServer(labelMap);
    const tempServer = tempServerInfo.server;
    const tempPort = tempServerInfo.port;
    const tempClose = tempServerInfo.close;

    try {
      const endpoint = `http://127.0.0.1:${tempPort}`;
      const config = makeConfig(suite, endpoint);

      const suitePath = await writeTempJson(
        tempDir,
        'suite-punct.json',
        suite,
      );
      const configPath = await writeTempJson(
        tempDir,
        'config-punct.json',
        config,
      );
      const outputPath = join(tempDir, 'record-punct.json');

      const exitCode = await runQualifyCheckerCli([
        suitePath,
        configPath,
        outputPath,
      ]);

      expect(exitCode).toBe(0); // error_rate 1/15 <= 0.1, still passes
      const record = JSON.parse(await readFile(outputPath, 'utf8'));
      expect(record.pass).toBe(true);
      expect(record.confusion.error.supported).toBe(1);
      expect(record.error_rate).toBeCloseTo(1 / 15);
    } finally {
      await tempClose();
    }
  });
});
