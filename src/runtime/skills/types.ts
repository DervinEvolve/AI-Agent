import * as crypto from 'node:crypto';

export interface SkillTestCase {
  args: Record<string, unknown>;
  expect_json: unknown;
}

export interface SkillRecord {
  skill_id: string;
  name: string;
  version: number;
  description: string;
  params_schema: Record<string, unknown>;
  code: string;
  code_sha256: string;
  schema_sha256: string;
  tests: SkillTestCase[];
  source_run_id: string;
  source_call_id: string;
  created_at: string;
}

export interface SkillManifestEntry {
  name: string;
  skill_id: string;
  version: number;
  code_sha256: string;
  schema_sha256: string;
}

export interface SkillExecutionReport {
  outcome: 'completed' | 'timeout' | 'error' | 'unknown';
  exit_code: number;
  stdout: string;
  stderr: string;
  termination_confirmed: boolean;
  cleanup_confirmed: boolean;
}

export type SkillExecutor = (
  code: string,
  timeoutMs: number,
  options?: { network?: boolean }
) => Promise<SkillExecutionReport>;

export interface SkillAuthorizerPayload {
  principal: string;
  purpose: 'skill';
  canonical_bytes: string;
}

export type SkillAuthorizer = (payload: SkillAuthorizerPayload) => Promise<boolean> | boolean;

export interface SkillCaps {
  maxActiveSkills: number;
  hardMaxActiveSkills: number;
  maxDescriptionBytes: number;
  maxParamsSchemaBytes: number;
  maxCodeBytes: number;
  maxTestsBytes: number;
  maxStdoutBytes: number;
  maxTotalStubBytes: number;
  maxProposalsPerRun: number;
  minTests: number;
  maxTests: number;
  minProperties: number;
  maxProperties: number;
  skillTestTimeoutMs: number;
  skillProposeTimeoutMs: number;
  authorizerTimeoutMs: number;
}

export const caps: SkillCaps = Object.freeze({
  maxActiveSkills: 16,
  hardMaxActiveSkills: 32,
  maxDescriptionBytes: 400,
  maxParamsSchemaBytes: 4 * 1024,
  maxCodeBytes: 16 * 1024,
  maxTestsBytes: 4 * 1024,
  maxStdoutBytes: 8 * 1024,
  maxTotalStubBytes: 32 * 1024,
  maxProposalsPerRun: 2,
  minTests: 1,
  maxTests: 5,
  minProperties: 1,
  maxProperties: 16,
  skillTestTimeoutMs: 10_000,
  skillProposeTimeoutMs: 45_000,
  authorizerTimeoutMs: 1_000,
});

export interface PinnedSkillActivation {
  name: string;
  version: number;
  code_sha256: string;
}

export interface SkillStoreFs {
  readFile(path: string, encoding: 'utf-8'): Promise<string>;
  writeFile(path: string, data: string, encoding: 'utf-8'): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
}

export interface SkillConfig {
  principal: string;
  storeDir: string;
  authorizer?: SkillAuthorizer;
  activation?: PinnedSkillActivation[] | 'latest_authorized';
  caps?: Partial<SkillCaps>;
  fs?: SkillStoreFs;
  clock?: () => number;
}

export function canonicalizeJson(val: unknown): string {
  if (val === null) return 'null';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) {
      throw new Error('canonicalizeJson: non-finite number not allowed');
    }
    return JSON.stringify(val);
  }
  if (typeof val === 'string') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    const elements = val.map((x) => canonicalizeJson(x));
    return `[${elements.join(',')}]`;
  }
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const pairs = sortedKeys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`);
    return `{${pairs.join(',')}}`;
  }
  throw new Error(`canonicalizeJson: unsupported type: ${typeof val}`);
}

export function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function buildSkillHarness(code: string, canonicalArgsJson: string): string {
  const b64 = Buffer.from(canonicalArgsJson, 'utf-8').toString('base64');
  return [
    'import sys, json, base64',
    code,
    'if __name__ == "__main__":',
    `    raw_args = base64.b64decode("${b64}").decode("utf-8")`,
    '    parsed_args = json.loads(raw_args)',
    '    result = run(parsed_args)',
    '    sys.stdout.write(json.dumps(result, separators=(",", ":")))',
  ].join('\n');
}
