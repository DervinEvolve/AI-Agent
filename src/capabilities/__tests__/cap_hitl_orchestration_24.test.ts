import { describe, it, expect, beforeAll, vi, beforeEach } from 'vitest';
import {
  HitlOrchestrator,
  HitlChannel,
  HitlRequest,
  HitlActionDetails,
} from '../cap_hitl_orchestration_24';

class TestChannel implements HitlChannel {
  requests: HitlRequest[] = [];
  async send(req: HitlRequest): Promise<void> {
    this.requests.push(req);
  }
}

describe('HitlOrchestrator', () => {
  let channel: TestChannel;
  let orchestrator: HitlOrchestrator;

  const baseAction: HitlActionDetails = {
    actionId: 'act-1',
    description: 'Delete production database',
    riskClass: 'critical',
    irreversibility: true,
    cost: 1000,
    unknownConsequence: true,
    tainted: true,
  };

  beforeEach(() => {
    channel = new TestChannel();
    orchestrator = new HitlOrchestrator({ channel, defaultTimeoutMs: 5000 });
  });

  it('requestApproval returns an approval id and sends request', async () => {
    const id = await orchestrator.requestApproval(baseAction);
    expect(id).toMatch(/^hitl-/);
    expect(channel.requests).toHaveLength(1);
    expect(channel.requests[0].approvalId).toBe(id);
    expect(channel.requests[0].status).toBe('pending');
  });

  it('checkStatus returns pending for fresh request', async () => {
    const id = await orchestrator.requestApproval(baseAction);
    expect(orchestrator.checkStatus(id)).toBe('pending');
  });

  it('checkStatus returns expired after timeout', async () => {
    const shortOrch = new HitlOrchestrator({ channel, defaultTimeoutMs: 0 });
    const id = await shortOrch.requestApproval(baseAction);
    // force timeout by advancing time? Use vi.advanceTimersByTime but need fake timers.
    vi.useFakeTimers();
    const id2 = await shortOrch.requestApproval(baseAction);
    vi.advanceTimersByTime(1);
    expect(shortOrch.checkStatus(id2)).toBe('expired');
    vi.useRealTimers();
  });

  describe('verifyApprovalToken', () => {
    let keyPair: { publicKey: string; privateKey: string };
    beforeAll(() => {
      keyPair = HitlOrchestrator.generateKeyPair();
    });

    it('accepts a valid signature and marks approved', async () => {
      const id = await orchestrator.requestApproval(baseAction, keyPair.publicKey);
      const sig = HitlOrchestrator.signAction(baseAction, keyPair.privateKey);
      const result = orchestrator.verifyApprovalToken(id, sig);
      expect(result.valid).toBe(true);
      expect(orchestrator.checkStatus(id)).toBe('approved');
    });

    it('rejects invalid signature', async () => {
      const id = await orchestrator.requestApproval(baseAction, keyPair.publicKey);
      const sig = 'invalid-signature-base64';
      const result = orchestrator.verifyApprovalToken(id, sig);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/invalid|crypto_error/);
    });

    it('rejects if no approver key', async () => {
      const id = await orchestrator.requestApproval(baseAction);
      const sig = HitlOrchestrator.signAction(baseAction, keyPair.privateKey);
      const result = orchestrator.verifyApprovalToken(id, sig);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('no_approver_key');
    });

    it('rejects unknown request', () => {
      const result = orchestrator.verifyApprovalToken('nonexistent', 'sig');
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('unknown_request');
    });

    it('rejects expired request', async () => {
      const id = await orchestrator.requestApproval(baseAction, keyPair.publicKey);
      // manually expire
      const req = (orchestrator as any).requests.get(id);
      req.status = 'expired';
      const sig = HitlOrchestrator.signAction(baseAction, keyPair.privateKey);
      const result = orchestrator.verifyApprovalToken(id, sig);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('not_pending');
    });
  });

  it('generateKeyPair produces usable keys', () => {
    const kp = HitlOrchestrator.generateKeyPair();
    expect(kp.publicKey).toBeTruthy();
    expect(kp.privateKey).toBeTruthy();
  });

  it('signAction produces verifiable signature', () => {
    const kp = HitlOrchestrator.generateKeyPair();
    const sig = HitlOrchestrator.signAction(baseAction, kp.privateKey);
    // Use orchestrator internal verify to confirm
    const testOrch = new HitlOrchestrator({ channel: new TestChannel() });
    const id = testOrch.requestApproval(baseAction, kp.publicKey).then((id) => {
      return testOrch.verifyApprovalToken(id, sig);
    });
    return expect(id).resolves.toMatchObject({ valid: true });
  });
});
