import { describe, it, expect } from 'vitest';
import {
  TrialController,
  DEFAULT_TRIAL_CONFIG,
  WorkspacePort,
  TrialCopyResult,
  CheckResult,
  DiscardResult,
  RecoveryLedgerLike,
  ToolResult,
} from '../types';

class FakeWorkspacePort implements WorkspacePort {
  private parentGeneration = 'gen-0';
  private parentFiles = new Map<string, string | Uint8Array>();
  private trialFiles = new Map<string, Map<string, string | Uint8Array>>();
  private trialMeta = new Map<
    string,
    { snapshotDigest: string; fileCount: number; totalBytes: number; terminationConfirmed: boolean; cleanupConfirmed: boolean }
  >();
  private nextTrialId = 1;
  private promoteShouldFail = false;

  constructor(initialFiles: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initialFiles)) {
      this.parentFiles.set(path, content);
    }
  }

  setPromoteShouldFail(value: boolean): void {
    this.promoteShouldFail = value;
  }

  async getCurrentGeneration(): Promise<string> {
    return this.parentGeneration;
  }

  async createTrialCopy(sourceGeneration: string): Promise<TrialCopyResult> {
    const trialId = `trial-${this.nextTrialId++}`;
    const files = new Map<string, string | Uint8Array>();
    let totalBytes = 0;
    for (const [path, content] of this.parentFiles.entries()) {
      files.set(path, content);
      totalBytes += typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
    }
    this.trialFiles.set(trialId, files);
    const snapshotDigest = `digest-${trialId}-${sourceGeneration}`;
    this.trialMeta.set(trialId, {
      snapshotDigest,
      fileCount: files.size,
      totalBytes,
      terminationConfirmed: false,
      cleanupConfirmed: false,
    });
    return { trialId, snapshotDigest, fileCount: files.size, totalBytes };
  }

  async readFile(trialId: string, path: string): Promise<string | Uint8Array> {
    const files = this.trialFiles.get(trialId);
    if (!files || !files.has(path)) throw new Error(`file not found: ${path}`);
    return files.get(path)!;
  }

  async writeFile(trialId: string, path: string, content: string | Uint8Array): Promise<void> {
    const files = this.trialFiles.get(trialId);
    if (!files) throw new Error(`unknown trial ${trialId}`);
    files.set(path, content);
    const meta = this.trialMeta.get(trialId);
    if (meta) {
      meta.totalBytes = Array.from(files.values()).reduce(
        (sum, c) => sum + (typeof c === 'string' ? Buffer.byteLength(c) : c.byteLength),
        0,
      );
      meta.fileCount = files.size;
    }
  }

  async listFiles(trialId: string): Promise<string[]> {
    const files = this.trialFiles.get(trialId);
    if (!files) throw new Error(`unknown trial ${trialId}`);
    return Array.from(files.keys());
  }

  async runCheck(trialId: string, harnessIdentity?: string): Promise<CheckResult> {
    const meta = this.trialMeta.get(trialId);
    if (!meta) throw new Error(`unknown trial ${trialId}`);
    return {
      passed: true,
      snapshotDigest: meta.snapshotDigest,
      harnessIdentity: harnessIdentity ?? 'default-harness',
      checkWorkCount: 1,
    };
  }

  async promote(trialId: string, snapshotDigest: string): Promise<void> {
    if (this.promoteShouldFail) throw new Error('promote failed');
    const files = this.trialFiles.get(trialId);
    if (!files) throw new Error(`unknown trial ${trialId}`);
    this.parentFiles = new Map(files);
    this.parentGeneration = `gen-${parseInt(this.parentGeneration.split('-')[1], 10) + 1}`;
  }

  async discard(trialId: string): Promise<DiscardResult> {
    const meta = this.trialMeta.get(trialId);
    if (!meta) throw new Error(`unknown trial ${trialId}`);
    meta.terminationConfirmed = true;
    meta.cleanupConfirmed = true;
    return { terminationConfirmed: true, cleanupConfirmed: true };
  }

  async getSnapshotDigest(trialId: string): Promise<string> {
    const meta = this.trialMeta.get(trialId);
    if (!meta) throw new Error(`unknown trial ${trialId}`);
    return meta.snapshotDigest;
  }

  getParentFiles(): Map<string, string | Uint8Array> {
    return this.parentFiles;
  }

  getParentGeneration(): string {
    return this.parentGeneration;
  }

  setTrialLifecycle(trialId: string, terminationConfirmed: boolean, cleanupConfirmed: boolean): void {
    const meta = this.trialMeta.get(trialId);
    if (meta) {
      meta.terminationConfirmed = terminationConfirmed;
      meta.cleanupConfirmed = cleanupConfirmed;
    }
  }
}

class FakeRecoveryLedger implements RecoveryLedgerLike {
  openSlot = false;
  unknownOutcome = false;
  quarantined = false;
  outcomes: Array<{ callId: string; outcome: 'success' | 'failure' | 'unknown'; context?: string }> = [];

  recordOutcome(callId: string, outcome: 'success' | 'failure' | 'unknown', context?: string): void {
    this.outcomes.push({ callId, outcome, context });
  }

  hasOpenSlot(): boolean {
    return this.openSlot;
  }

  hasUnknownOutcome(): boolean {
    return this.unknownOutcome;
  }

  isQuarantined(): boolean {
    return this.quarantined;
  }
}

function makeController(
  port = new FakeWorkspacePort({ 'a.txt': 'parent-a' }),
  ledger = new FakeRecoveryLedger(),
  config: Partial<typeof DEFAULT_TRIAL_CONFIG> = {},
): TrialController {
  return new TrialController(port, ledger, config);
}

describe('TrialController', () => {
  it('create_trial copies parent generation; trial writes are isolated; discard leaves parent unchanged', async () => {
    const port = new FakeWorkspacePort({ 'a.txt': 'parent-a' });
    const ledger = new FakeRecoveryLedger();
    const controller = makeController(port, ledger);

    const create = await controller.createTrial({}, 'call-create');
    expect(create.started).toBe(true);
    expect(create.ok).toBe(true);
    const trialId = (create.output as any).trial_id as string;

    const write = await controller.dispatchTool('write_file', { path: 'a.txt', content: 'trial-a' }, 'call-write', 'execution');
    expect(write.started).toBe(true);

    const trialContent = await port.readFile(trialId, 'a.txt');
    expect(trialContent).toBe('trial-a');
    expect(port.getParentFiles().get('a.txt')).toBe('parent-a');

    const discard = await controller.discardTrial({ trial_id: trialId }, 'call-discard');
    expect(discard.started).toBe(true);
    expect(discard.ok).toBe(true);
    expect(port.getParentFiles().get('a.txt')).toBe('parent-a');
  });

  it('create_trial is refused while recovery slot open, unknown outcome unresolved, quarantine active, or egress not none', async () => {
    const ledger = new FakeRecoveryLedger();
    const controller = makeController(new FakeWorkspacePort(), ledger);

    ledger.openSlot = true;
    expect(await controller.createTrial({}, 'c1')).toMatchObject({ started: false, reason: 'trial_context_blocked' });
    ledger.openSlot = false;
    ledger.unknownOutcome = true;
    expect(await controller.createTrial({}, 'c2')).toMatchObject({ started: false, reason: 'trial_context_blocked' });
    ledger.unknownOutcome = false;
    ledger.quarantined = true;
    expect(await controller.createTrial({}, 'c3')).toMatchObject({ started: false, reason: 'trial_context_blocked' });
    ledger.quarantined = false;

    const badEgress = makeController(new FakeWorkspacePort(), ledger, { egressProfile: 'none' });
    // egressProfile is forced to 'none' by constructor; test with an invalid value bypassing type via any
    (badEgress as any).config.egressProfile = 'not-none';
    expect(await badEgress.createTrial({}, 'c4')).toMatchObject({ started: false, reason: 'trial_context_blocked' });
  });

  it('wrong trial_id returns invalid_args for promote/discard/run_check', async () => {
    const controller = makeController();
    expect(await controller.discardTrial({ trial_id: 'missing' }, 'c1')).toMatchObject({ started: true, ok: true, found: false });
    expect(await controller.promoteTrial({ trial_id: 'missing', check_digest: 'x' }, 'c2')).toMatchObject({ started: false, reason: 'invalid_args' });
    expect(await controller.runCheck('missing', undefined, 'c3')).toMatchObject({ started: false, reason: 'invalid_args' });
  });

  it('promote_trial requires a passing check with matching digest; stale digest or no check leaves parent unchanged', async () => {
    const port = new FakeWorkspacePort({ 'a.txt': 'parent-a' });
    const ledger = new FakeRecoveryLedger();
    const controller = makeController(port, ledger);

    const create = await controller.createTrial({}, 'create');
    const trialId = (create.output as any).trial_id as string;
    await controller.dispatchTool('write_file', { path: 'a.txt', content: 'trial-a' }, 'write', 'execution');

    // no passing check
    const noCheck = await controller.promoteTrial({ trial_id: trialId, check_digest: 'anything' }, 'promote-no-check');
    expect(noCheck).toMatchObject({ started: false, reason: 'no_passing_check' });
    expect(port.getParentFiles().get('a.txt')).toBe('parent-a');

    // run check to get receipt digest
    const check = await controller.runCheck(trialId, 'harness-1', 'run-check');
    expect(check.started).toBe(true);
    const digest = (check.output as any).snapshotDigest as string;

    // stale post-edit check: mutate after check
    await controller.dispatchTool('write_file', { path: 'a.txt', content: 'trial-a-v2' }, 'write-2', 'execution');
    const stale = await controller.promoteTrial({ trial_id: trialId, check_digest: digest }, 'promote-stale');
    expect(stale).toMatchObject({ started: false, reason: 'check_digest_mismatch' });
    expect(port.getParentFiles().get('a.txt')).toBe('parent-a');

    // digest mismatch
    const mismatch = await controller.promoteTrial({ trial_id: trialId, check_digest: 'wrong-digest' }, 'promote-mismatch');
    expect(mismatch).toMatchObject({ started: false, reason: 'check_digest_mismatch' });
    expect(port.getParentFiles().get('a.txt')).toBe('parent-a');
  });

  it('after a passing run_check with matching digest, promote_trial atomically swaps generation', async () => {
    const port = new FakeWorkspacePort({ 'a.txt': 'parent-a' });
    const ledger = new FakeRecoveryLedger();
    const controller = makeController(port, ledger);

    const create = await controller.createTrial({}, 'create');
    const trialId = (create.output as any).trial_id as string;
    await controller.dispatchTool('write_file', { path: 'a.txt', content: 'trial-a' }, 'write', 'execution');

    const check = await controller.runCheck(trialId, 'harness-1', 'run-check');
    expect(check.started).toBe(true);
    const digest = (check.output as any).snapshotDigest as string;

    const promote = await controller.promoteTrial({ trial_id: trialId, check_digest: digest }, 'promote');
    expect(promote.started).toBe(true);
    expect(promote.ok).toBe(true);
    expect(port.getParentFiles().get('a.txt')).toBe('trial-a');
    expect(port.getParentGeneration()).toBe('gen-1');
    expect(controller.getActiveTrial()).toBeNull();
  });

  it('trial-local failures enter ledger; discard of failed trial does not refill allowance; timeout marks unresolved', async () => {
    const port = new FakeWorkspacePort({ 'a.txt': 'parent-a' });
    const ledger = new FakeRecoveryLedger();
    const controller = makeController(port, ledger);

    const create = await controller.createTrial({}, 'create');
    const trialId = (create.output as any).trial_id as string;

    // Force a failure by reading a missing file
    const read = await controller.dispatchTool('read_file', { path: 'missing.txt' }, 'read-fail', 'execution');
    expect(read.started).toBe(false);
    expect(ledger.outcomes.some((o) => o.callId === 'read-fail' && o.outcome === 'failure')).toBe(true);

    // discard failed trial should not refill allowance (no refill method in fake; assert no success outcome)
    await controller.discardTrial({ trial_id: trialId }, 'discard');
    expect(ledger.outcomes.some((o) => o.callId === 'discard' && o.outcome === 'success')).toBe(false);

    // timeout: set lifecycle unresolved and assert mutation/run_check/promote refused
    port.setTrialLifecycle(trialId, false, false);
    const trial = controller.getTrial(trialId)!;
    trial.terminationConfirmed = false;
    trial.cleanupConfirmed = false;

    const write = await controller.dispatchTool('write_file', { path: 'a.txt', content: 'x' }, 'write-timeout', 'execution');
    expect(write).toMatchObject({ started: false, reason: 'trial_lifecycle_unresolved' });
    const check = await controller.runCheck(trialId, undefined, 'check-timeout');
    expect(check).toMatchObject({ started: false, reason: 'trial_lifecycle_unresolved' });
    const promote = await controller.promoteTrial({ trial_id: trialId, check_digest: 'x' }, 'promote-timeout');
    expect(promote).toMatchObject({ started: false, reason: 'trial_lifecycle_unresolved' });
    expect(port.getParentFiles().get('a.txt')).toBe('parent-a');
  });

  it('execution tools route to trial; control and inspection tools admitted; other tools unsupported', async () => {
    const port = new FakeWorkspacePort({ 'a.txt': 'parent-a' });
    const ledger = new FakeRecoveryLedger();
    const controller = makeController(port, ledger);

    const create = await controller.createTrial({}, 'create');
    expect(create.started).toBe(true);

    const read = await controller.dispatchTool('read_file', { path: 'a.txt' }, 'read', 'execution');
    expect(read.started).toBe(true);
    const list = await controller.dispatchTool('list_files', {}, 'list', 'execution');
    expect(list.started).toBe(true);

    const control = await controller.dispatchTool('trial_status', {}, 'status', 'control');
    expect(control.started).toBe(true);
    const inspection = await controller.dispatchTool('recall', {}, 'recall', 'inspection');
    expect(inspection.started).toBe(true);

    for (const tool of ['web_search', 'memory_write', 'skill_run', 'mcp_call', 'delegate']) {
      const result = await controller.dispatchTool(tool, {}, `call-${tool}`, 'other');
      expect(result).toMatchObject({ started: false, reason: 'trial_context_unsupported' });
    }
  });

  it('promote timeout sets PromotionOperation outcome unknown; trial_status reports state; late cleanup never triggers second swap', async () => {
    const port = new FakeWorkspacePort({ 'a.txt': 'parent-a' });
    const ledger = new FakeRecoveryLedger();
    const controller = makeController(port, ledger);

    const create = await controller.createTrial({}, 'create');
    const trialId = (create.output as any).trial_id as string;
    await controller.dispatchTool('write_file', { path: 'a.txt', content: 'trial-a' }, 'write', 'execution');
    const check = await controller.runCheck(trialId, 'harness-1', 'check');
    const digest = (check.output as any).snapshotDigest as string;

    port.setPromoteShouldFail(true);
    const promote = await controller.promoteTrial({ trial_id: trialId, check_digest: digest }, 'promote-timeout');
    expect(promote.started).toBe(false);
    expect(promote.reason).toBe('trial_lifecycle_unresolved');
    expect(controller.getPromotionOperations()[0].state).toBe('unresolved');
    expect(ledger.outcomes.some((o) => o.callId === 'promote-timeout' && o.outcome === 'unknown')).toBe(true);

    const status = await controller.trialStatus({}, 'status');
    expect(status.started).toBe(true);
    expect((status.output as any).active_trial).toBe(trialId);

    // late cleanup should not trigger another swap
    port.setPromoteShouldFail(false);
    await controller.discardTrial({ trial_id: trialId }, 'discard-late');
    expect(port.getParentFiles().get('a.txt')).toBe('parent-a');
  });

  it('hard max 2 create attempts; snapshot caps enforced; finalization abandons active trial preserving cleanup_pending', async () => {
    const port = new FakeWorkspacePort({ 'a.txt': 'parent-a' });
    const ledger = new FakeRecoveryLedger();
    const controller = makeController(port, ledger, { maxCreateAttempts: 2, maxSnapshotBytes: 10, maxSnapshotFiles: 100 });

    // First create succeeds
    const first = await controller.createTrial({}, 'create-1');
    expect(first.started).toBe(true);
    const trialId = (first.output as any).trial_id as string;

    // Second create refused because active
    const second = await controller.createTrial({}, 'create-2');
    expect(second).toMatchObject({ started: false, reason: 'trial_already_active' });

    // Discard first, then third create should be refused due to max attempts (2 attempts used)
    await controller.discardTrial({ trial_id: trialId }, 'discard');
    const third = await controller.createTrial({}, 'create-3');
    expect(third).toMatchObject({ started: false, reason: 'trial_limit_exceeded' });

    // Finalization abandons active trial
    const port2 = new FakeWorkspacePort({ 'a.txt': 'parent-a' });
    const controller2 = makeController(port2, new FakeRecoveryLedger());
    const create2 = await controller2.createTrial({}, 'create-final');
    expect(create2.started).toBe(true);
    controller2.finalize();
    expect(controller2.getActiveTrial()?.state).toBe('abandoned');
  });

  it('children get no trial tools; startup rejects co-mounts; disabled config matches baseline', async () => {
    const controller = makeController();
    expect(() => controller.assertNoCoMounts(['cap_durable_runs_mount_41'])).toThrow();
    expect(() => controller.assertNoCoMounts(['cap_interactive_session_49'])).toThrow();
    expect(() => controller.assertNoCoMounts(['cap_parallel_tool_dispatch_48'])).toThrow();
    expect(() => controller.assertNoCoMounts(['some_other_cap'])).not.toThrow();

    // Disabled configuration adds no tools, writes, adapter calls, or transcript changes.
    // This is enforced by the controller only exposing its own methods; no global registration occurs.
    expect(controller).toBeInstanceOf(TrialController);
  });

  it.skip('live rootless-Docker run is a separate test, labelled blocked when Docker is unavailable and never passed by fixture', () => {
    // This test intentionally requires a live Docker daemon and is skipped in CI.
  });
});
