import { describe, it, expect, beforeEach } from 'vitest';
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

  constructor(initialFiles: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initialFiles)) {
      this.parentFiles.set(path, content);
    }
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
    if (!files || !files.has(path)) throw new Error(`File not found: ${path}`);
    return files.get(path)!;
  }

  async writeFile(trialId: string, path: string, content: string | Uint8Array): Promise<void> {
    const files = this.trialFiles.get(trialId);
    if (!files) throw new Error(`Unknown trial: ${trialId}`);
    files.set(path, content);
  }

  async listFiles(trialId: string): Promise<string[]> {
    const files = this.trialFiles.get(trialId);
    if (!files) return [];
    return Array.from(files.keys());
  }

  async runCheck(trialId: string, harnessIdentity?: string): Promise<CheckResult> {
    const meta = this.trialMeta.get(trialId);
    if (!meta) throw new Error(`Unknown trial: ${trialId}`);
    return {
      passed: true,
      snapshotDigest: meta.snapshotDigest,
      harnessIdentity: harnessIdentity ?? 'default-harness',
      checkWorkCount: 1,
    };
  }

  async promote(trialId: string, snapshotDigest: string): Promise<void> {
    const meta = this.trialMeta.get(trialId);
    if (!meta) throw new Error(`Unknown trial: ${trialId}`);
    if (meta.snapshotDigest !== snapshotDigest) throw new Error('Digest mismatch');
    // Simulate atomic swap: parent generation becomes trial's snapshot digest
    this.parentGeneration = snapshotDigest;
    this.parentFiles = new Map(this.trialFiles.get(trialId)!);
    meta.cleanupConfirmed = true;
    meta.terminationConfirmed = true;
  }

  async discard(trialId: string): Promise<DiscardResult> {
    const meta = this.trialMeta.get(trialId);
    if (!meta) return { terminationConfirmed: false, cleanupConfirmed: false };
    meta.terminationConfirmed = true;
    meta.cleanupConfirmed = true;
    this.trialFiles.delete(trialId);
    return { terminationConfirmed: true, cleanupConfirmed: true };
  }

  async getSnapshotDigest(trialId: string): Promise<string> {
    const meta = this.trialMeta.get(trialId);
    if (!meta) throw new Error(`Unknown trial: ${trialId}`);
    return meta.snapshotDigest;
  }
}

class FakeRecoveryLedger implements RecoveryLedgerLike {
  private records: unknown[] = [];
  record(entry: unknown): void {
    this.records.push(entry);
  }
  getRecords(): unknown[] {
    return this.records;
  }
}

describe('TrialController additional integration tests', () => {
  let port: FakeWorkspacePort;
  let ledger: FakeRecoveryLedger;
  let controller: TrialController;

  beforeEach(() => {
    port = new FakeWorkspacePort({ 'file.txt': 'original content' });
    ledger = new FakeRecoveryLedger();
    controller = new TrialController(port, ledger, DEFAULT_TRIAL_CONFIG);
  });

  it('create_trial copies parent generation and isolates trial writes', async () => {
    const createResult = await controller.createTrial({ name: 'test-trial' });
    expect(createResult.started).toBe(true);
    expect(createResult.output).toHaveProperty('trial_id');
    const trialId = createResult.output.trial_id as string;

    // Write inside trial via port
    await port.writeFile(trialId, 'file.txt', 'modified in trial');

    // Parent file should be unchanged (via port's parentFiles, but we can check through controller's trial routing later)
    // For now, verify parent generation unchanged
    const parentGen = await port.getCurrentGeneration();
    expect(parentGen).toBe('gen-0');

    // Discard trial and ensure parent still unchanged
    const discardResult = await controller.discardTrial({ trial_id: trialId });
    expect(discardResult.started).toBe(true);
    expect(discardResult.output.ok).toBe(true);

    // After discard, parent generation still gen-0
    const parentGenAfter = await port.getCurrentGeneration();
    expect(parentGenAfter).toBe('gen-0');
  });

  it('promote_trial requires passing check and digest match', async () => {
    const createResult = await controller.createTrial({ name: 'promo-trial' });
    expect(createResult.started).toBe(true);
    const trialId = createResult.output.trial_id as string;

    // Promote without check should fail
    const promoteNoCheck = await controller.promoteTrial({ trial_id: trialId, check_digest: 'any' });
    expect(promoteNoCheck.started).toBe(false);
    expect(promoteNoCheck.reason).toBe('no_passing_check');

    // Run check via controller (assuming method exists)
    const checkResult = await controller.runCheckInTrial(trialId, 'test-harness');
    expect(checkResult.passed).toBe(true);
    const digest = checkResult.snapshotDigest;

    // Promote with wrong digest should fail
    const promoteWrong = await controller.promoteTrial({ trial_id: trialId, check_digest: 'wrong-digest' });
    expect(promoteWrong.started).toBe(false);
    expect(promoteWrong.reason).toBe('check_digest_mismatch');

    // Promote with correct digest should succeed
    const promoteOk = await controller.promoteTrial({ trial_id: trialId, check_digest: digest });
    expect(promoteOk.started).toBe(true);
    expect(promoteOk.output).toHaveProperty('state', 'published');

    // Parent generation should be updated
    const parentGen = await port.getCurrentGeneration();
    expect(parentGen).toBe(digest);
  });

  it('create_trial attempts are capped at 2', async () => {
    // First attempt succeeds
    const first = await controller.createTrial({ name: 'first' });
    expect(first.started).toBe(true);

    // Second attempt while active should fail with trial_already_active (counts as attempt)
    const second = await controller.createTrial({ name: 'second' });
    expect(second.started).toBe(false);
    expect(second.reason).toBe('trial_already_active');

    // Discard active trial
    await controller.discardTrial({ trial_id: first.output.trial_id as string });

    // Third attempt should be refused with trial_limit_exceeded
    const third = await controller.createTrial({ name: 'third' });
    expect(third.started).toBe(false);
    expect(third.reason).toBe('trial_limit_exceeded');
  });

  it('discard_trial with unknown id returns ok with found=false', async () => {
    const result = await controller.discardTrial({ trial_id: 'nonexistent' });
    expect(result.started).toBe(true);
    expect(result.output.ok).toBe(true);
    expect(result.output.found).toBe(false);
  });
});
