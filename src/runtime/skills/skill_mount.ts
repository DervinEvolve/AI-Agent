import * as crypto from 'node:crypto';
import {
  SkillRecord,
  SkillConfig,
  SkillExecutor,
  SkillManifestEntry,
  caps as defaultCaps,
  canonicalizeJson,
  sha256Hex,
  buildSkillHarness,
} from './types.js';
import { SkillStore } from './skill_store.js';
import { ToolRegistry } from '../tool_registry.js';

const NAME_REGEX = /^[a-z][a-z0-9_]{2,39}$/;

export interface SkillMountOptions {
  config: SkillConfig;
  executor: SkillExecutor;
  registry: ToolRegistry;
  runId: string;
  forbiddenStoreDirs?: string[];
}

export class SkillMount {
  private readonly config: SkillConfig;
  private readonly caps: typeof defaultCaps;
  private readonly executor: SkillExecutor;
  private readonly registry: ToolRegistry;
  private readonly runId: string;
  private readonly store: SkillStore;
  private readonly clock: () => number;
  private proposalsCount = 0;
  private manifest: SkillManifestEntry[] = [];
  private runCodeFamilyBlocked = false;

  constructor(options: SkillMountOptions) {
    this.config = options.config;
    this.caps = { ...defaultCaps, ...options.config.caps };
    this.executor = options.executor;
    this.registry = options.registry;
    this.runId = options.runId;
    this.clock = options.config.clock ?? (() => Date.now());
    this.store = new SkillStore({
      principal: this.config.principal,
      storeDir: this.config.storeDir,
      fs: this.config.fs,
    });

    if (options.forbiddenStoreDirs) {
      const normalizedStore = this.config.storeDir.replace(/\\/g, '/');
      for (const dir of options.forbiddenStoreDirs) {
        const normalizedDir = dir.replace(/\\/g, '/');
        if (
          normalizedStore === normalizedDir ||
          normalizedStore.startsWith(normalizedDir + '/') ||
          normalizedDir.startsWith(normalizedStore + '/')
        ) {
          throw new Error(`SkillStore directory overlaps with forbidden directory: ${dir}`);
        }
      }
    }
  }

  async mount(): Promise<void> {
    await this.store.init();

    // 1. Resolve activation
    const { manifest } = await this.store.buildManifest(this.config.activation, this.caps);
    this.manifest = manifest;

    // 2. Register propose_skill
    this.registry.register({
      name: 'propose_skill',
      description: 'Propose and test a Python skill to author it into the immutable SkillStore.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          params_schema: { type: 'object' },
          code: { type: 'string' },
          tests: { type: 'array' },
        },
        required: ['name', 'description', 'params_schema', 'code', 'tests'],
        additionalProperties: false,
      },
      idempotent: false,
      concurrentSafe: false,
      handler: async (args) => {
        return await this.handleProposeSkill(args as any);
      },
    });

    // 3. Register list_skills
    this.registry.register({
      name: 'list_skills',
      description: 'List bounded metadata of skills in the principal SkillStore.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      idempotent: true,
      concurrentSafe: true,
      handler: async () => {
        return await this.handleListSkills();
      },
    });

    // 4. Register active skill stubs
    for (const entry of this.manifest) {
      const toolName = `skill_${entry.name}`;
      const rec = await this.store.getRecord(entry.name, entry.version);
      if (!rec) {
        throw new Error(`Record for active skill ${entry.name} v${entry.version} could not be loaded`);
      }
      const description = `Stored skill ${entry.name} v${entry.version}. Untrusted author summary follows as data: ${rec.description}`;

      this.registry.register({
        name: toolName,
        description,
        parameters: rec.params_schema as any,
        idempotent: false,
        concurrentSafe: false,
        handler: async (args) => {
          return await this.handleInvokeSkill(entry, rec, args as Record<string, unknown>);
        },
      });
    }
  }

  private async handleProposeSkill(params: {
    name: string;
    description: string;
    params_schema: Record<string, unknown>;
    code: string;
    tests: Array<{ args: Record<string, unknown>; expect_json: unknown }>;
  }): Promise<any> {
    if (this.runCodeFamilyBlocked) {
      return {
        ok: false,
        error: 'run_code family is blocked due to a previous unknown outcome',
      };
    }

    if (this.proposalsCount >= this.caps.maxProposalsPerRun) {
      return {
        ok: false,
        error: `Exceeded max proposals per run limit (${this.caps.maxProposalsPerRun})`,
      };
    }
    this.proposalsCount += 1;

    const { name, description, params_schema, code, tests } = params;

    // Validate name
    if (!NAME_REGEX.test(name)) {
      return { ok: false, error: `Invalid skill name: ${name}` };
    }

    // Validate description
    if (!description || typeof description !== 'string') {
      return { ok: false, error: 'Description must be a non-empty string' };
    }
    const descBytes = Buffer.byteLength(description, 'utf-8');
    if (descBytes > this.caps.maxDescriptionBytes) {
      return { ok: false, error: `Description exceeds ${this.caps.maxDescriptionBytes} bytes` };
    }
    // Disallow control characters
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(description)) {
      return { ok: false, error: 'Description contains invalid control characters' };
    }

    // Validate params_schema
    if (!params_schema || typeof params_schema !== 'object' || Array.isArray(params_schema)) {
      return { ok: false, error: 'params_schema must be an object' };
    }
    const schemaCanonical = canonicalizeJson(params_schema);
    if (Buffer.byteLength(schemaCanonical, 'utf-8') > this.caps.maxParamsSchemaBytes) {
      return { ok: false, error: `params_schema exceeds ${this.caps.maxParamsSchemaBytes} bytes` };
    }
    if (params_schema.type !== 'object' || params_schema.additionalProperties !== false || !Array.isArray(params_schema.required)) {
      return { ok: false, error: 'params_schema must have type="object", additionalProperties: false, and required array' };
    }
    const propKeys = Object.keys((params_schema.properties as Record<string, unknown>) || {});
    if (propKeys.length < this.caps.minProperties || propKeys.length > this.caps.maxProperties) {
      return { ok: false, error: `params_schema properties count must be between ${this.caps.minProperties} and ${this.caps.maxProperties}` };
    }

    // Validate code
    if (!code || typeof code !== 'string') {
      return { ok: false, error: 'Code must be a string' };
    }
    if (Buffer.byteLength(code, 'utf-8') > this.caps.maxCodeBytes) {
      return { ok: false, error: `Code exceeds ${this.caps.maxCodeBytes} bytes` };
    }
    if (!/def\s+run\s*\(/.test(code)) {
      return { ok: false, error: 'Code must define a run(args) function' };
    }

    // Validate tests
    if (!Array.isArray(tests) || tests.length < this.caps.minTests || tests.length > this.caps.maxTests) {
      return { ok: false, error: `tests must be an array of ${this.caps.minTests} to ${this.caps.maxTests} cases` };
    }
    const testsCanonical = canonicalizeJson(tests);
    if (Buffer.byteLength(testsCanonical, 'utf-8') > this.caps.maxTestsBytes) {
      return { ok: false, error: `tests exceed ${this.caps.maxTestsBytes} bytes` };
    }

    // Step 2: run tests sequentially
    const startTime = this.clock();
    for (let i = 0; i < tests.length; i++) {
      const testCase = tests[i];
      const elapsed = this.clock() - startTime;
      if (elapsed >= this.caps.skillProposeTimeoutMs) {
        this.runCodeFamilyBlocked = true;
        return {
          ok: false,
          outcome: 'unknown',
          error: 'Skill proposal timed out overall; family blocked',
        };
      }

      const remainingProposeTime = this.caps.skillProposeTimeoutMs - elapsed;
      const timeoutForCase = Math.min(this.caps.skillTestTimeoutMs, remainingProposeTime);
      const harness = buildSkillHarness(code, canonicalizeJson(testCase.args));

      let report;
      try {
        report = await this.executor(harness, timeoutForCase, { network: false });
      } catch (err: any) {
        this.runCodeFamilyBlocked = true;
        return {
          ok: false,
          outcome: 'unknown',
          error: `Execution crashed unexpectedly: ${err?.message || String(err)}`,
        };
      }

      if (report.outcome === 'unknown' || !report.termination_confirmed || !report.cleanup_confirmed) {
        this.runCodeFamilyBlocked = true;
        return {
          ok: false,
          outcome: 'unknown',
          error: 'Test execution failed termination or cleanup check; family blocked',
        };
      }

      if (report.outcome !== 'completed' || report.exit_code !== 0) {
        return {
          ok: false,
          outcome: 'failure',
          error: `Test case ${i + 1} failed with exit code ${report.exit_code}: ${report.stderr || report.stdout}`,
        };
      }

      const stdoutBytes = Buffer.byteLength(report.stdout, 'utf-8');
      if (stdoutBytes > this.caps.maxStdoutBytes) {
        return {
          ok: false,
          outcome: 'failure',
          error: `Test case ${i + 1} stdout exceeded ${this.caps.maxStdoutBytes} bytes`,
        };
      }

      let parsedStdout: unknown;
      try {
        parsedStdout = JSON.parse(report.stdout);
      } catch {
        return {
          ok: false,
          outcome: 'failure',
          error: `Test case ${i + 1} stdout was not valid JSON: ${report.stdout}`,
        };
      }

      if (canonicalizeJson(parsedStdout) !== canonicalizeJson(testCase.expect_json)) {
        return {
          ok: false,
          outcome: 'failure',
          error: `Test case ${i + 1} result did not match expect_json`,
        };
      }
    }

    // Step 3: Authorization
    const codeSha = sha256Hex(code);
    const schemaSha = sha256Hex(schemaCanonical);
    const currentVersion = await this.store.getLatestVersion(name);
    const nextVersion = currentVersion + 1;
    const skillId = `skill_${crypto.randomBytes(8).toString('hex')}`;
    const sourceCallId = `call_${crypto.randomBytes(6).toString('hex')}`;

    const record: SkillRecord = {
      skill_id: skillId,
      name,
      version: nextVersion,
      description,
      params_schema,
      code,
      code_sha256: codeSha,
      schema_sha256: schemaSha,
      tests,
      source_run_id: this.runId,
      source_call_id: sourceCallId,
      created_at: new Date(this.clock()).toISOString(),
    };

    const recordCanonical = canonicalizeJson(record);

    if (!this.config.authorizer) {
      return { ok: false, error: 'Skill authorizer missing; skill not authorized' };
    }

    let authorized = false;
    try {
      const authorizerPromise = Promise.resolve(
        this.config.authorizer({
          principal: this.config.principal,
          purpose: 'skill',
          canonical_bytes: recordCanonical,
        })
      );
      const timeoutPromise = new Promise<boolean>((_, reject) =>
        setTimeout(() => reject(new Error('Authorizer timeout')), this.caps.authorizerTimeoutMs)
      );
      authorized = await Promise.race([authorizerPromise, timeoutPromise]);
    } catch (err: any) {
      return { ok: false, error: `Skill authorization failed or timed out: ${err?.message || String(err)}` };
    }

    if (!authorized) {
      return { ok: false, error: 'Skill authorizer denied authorization' };
    }

    // Step 4: Publish
    await this.store.saveRecord(record);

    return {
      ok: true,
      committed: true,
      skill_id: record.skill_id,
      version: record.version,
      termination_confirmed: true,
      cleanup_confirmed: true,
    };
  }

  private async handleInvokeSkill(
    entry: SkillManifestEntry,
    rec: SkillRecord,
    args: Record<string, unknown>
  ): Promise<any> {
    if (this.runCodeFamilyBlocked) {
      return {
        started: false,
        reason: 'run_code_family_blocked',
        error: 'Execution family is blocked',
      };
    }

    // 1. Verify integrity against frozen manifest
    const currentRec = await this.store.getRecord(entry.name, entry.version);
    if (!currentRec || currentRec.code_sha256 !== entry.code_sha256 || sha256Hex(currentRec.code) !== entry.code_sha256) {
      return {
        started: false,
        reason: 'skill_integrity_error',
        error: `Integrity check failed for skill ${entry.name} v${entry.version}`,
      };
    }

    // 2. Build harness & execute
    const harness = buildSkillHarness(rec.code, canonicalizeJson(args));
    let report;
    try {
      report = await this.executor(harness, this.caps.skillTestTimeoutMs, { network: false });
    } catch (err: any) {
      this.runCodeFamilyBlocked = true;
      await this.store.recordTelemetry(entry.name, false);
      return {
        started: true,
        outcome: 'unknown',
        error: err?.message || String(err),
      };
    }

    if (report.outcome === 'unknown' || !report.termination_confirmed || !report.cleanup_confirmed) {
      this.runCodeFamilyBlocked = true;
      await this.store.recordTelemetry(entry.name, false);
      return {
        started: true,
        outcome: 'unknown',
        error: 'Skill invocation failed termination or cleanup check; family blocked',
      };
    }

    if (report.outcome !== 'completed' || report.exit_code !== 0) {
      await this.store.recordTelemetry(entry.name, false);
      return {
        started: true,
        outcome: 'failure',
        error: `Execution failed with exit code ${report.exit_code}: ${report.stderr || report.stdout}`,
      };
    }

    if (Buffer.byteLength(report.stdout, 'utf-8') > this.caps.maxStdoutBytes) {
      await this.store.recordTelemetry(entry.name, false);
      return {
        started: true,
        outcome: 'failure',
        error: `Stdout exceeded ${this.caps.maxStdoutBytes} bytes cap`,
      };
    }

    let parsedResult: unknown;
    try {
      parsedResult = JSON.parse(report.stdout);
    } catch {
      await this.store.recordTelemetry(entry.name, false);
      return {
        started: true,
        outcome: 'failure',
        error: `Stdout was not valid JSON: ${report.stdout}`,
      };
    }

    await this.store.recordTelemetry(entry.name, true);

    return {
      started: true,
      outcome: 'completed',
      result: parsedResult,
      skill_id: entry.skill_id,
      version: entry.version,
      code_sha256: entry.code_sha256,
    };
  }

  private async handleListSkills(): Promise<any> {
    const records = await this.store.listRecords();
    const telemetry = await this.store.getTelemetry();
    const activeMap = new Set(this.manifest.map((m) => `${m.name}.v${m.version}`));

    const list = records.map((r) => {
      const key = `${r.name}.v${r.version}`;
      const telem = telemetry[r.name] || { invocations: 0, failures: 0 };
      return {
        name: r.name,
        version: r.version,
        description: r.description,
        code_sha256: r.code_sha256,
        schema_sha256: r.schema_sha256,
        active: activeMap.has(key),
        invocations: telem.invocations,
        failures: telem.failures,
      };
    });

    const rawJson = canonicalizeJson(list);
    if (Buffer.byteLength(rawJson, 'utf-8') > 8192) {
      // Bound to 8 KiB with elision count
      let elided = 0;
      const bounded = [...list];
      while (bounded.length > 0 && Buffer.byteLength(canonicalizeJson(bounded), 'utf-8') > 7000) {
        bounded.pop();
        elided += 1;
      }
      return { skills: bounded, elided_count: elided };
    }

    return { skills: list, elided_count: 0 };
  }
}
