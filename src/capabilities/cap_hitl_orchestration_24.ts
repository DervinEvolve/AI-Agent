import { createHash, sign as cryptoSign, verify as cryptoVerify, generateKeyPairSync } from 'node:crypto';

export interface HitlActionDetails {
  actionId: string;
  description: string;
  riskClass: 'low' | 'medium' | 'high' | 'critical';
  irreversibility: boolean;
  cost: number;
  unknownConsequence: boolean;
  tainted: boolean;
}

export interface HitlRequest {
  approvalId: string;
  action: HitlActionDetails;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  createdAt: number;
  timeoutAt: number;
  approverPublicKey?: string;
  signature?: string;
}

export interface HitlChannel {
  send(request: HitlRequest): Promise<void>;
}

export class HitlOrchestrator {
  private requests: Map<string, HitlRequest> = new Map();
  private channel: HitlChannel;
  private defaultTimeoutMs: number;

  constructor(options: {
    channel: HitlChannel;
    defaultTimeoutMs?: number;
  }) {
    this.channel = options.channel;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 300_000; // 5 minutes
  }

  async requestApproval(action: HitlActionDetails, approverPublicKey?: string): Promise<string> {
    const approvalId = this.generateApprovalId();
    const now = Date.now();
    const request: HitlRequest = {
      approvalId,
      action,
      status: 'pending',
      createdAt: now,
      timeoutAt: now + this.defaultTimeoutMs,
      approverPublicKey,
    };
    this.requests.set(approvalId, request);
    await this.channel.send(request);
    return approvalId;
  }

  checkStatus(approvalId: string): HitlRequest['status'] | null {
    const req = this.requests.get(approvalId);
    if (!req) return null;
    if (req.status === 'pending' && Date.now() > req.timeoutAt) {
      req.status = 'expired';
    }
    return req.status;
  }

  verifyApprovalToken(approvalId: string, tokenSignature: string): { valid: boolean; reason?: string } {
    const req = this.requests.get(approvalId);
    if (!req) return { valid: false, reason: 'unknown_request' };
    if (req.status !== 'pending') return { valid: false, reason: 'not_pending' };
    if (Date.now() > req.timeoutAt) {
      req.status = 'expired';
      return { valid: false, reason: 'expired' };
    }
    const publicKeyBase64 = req.approverPublicKey;
    if (!publicKeyBase64) return { valid: false, reason: 'no_approver_key' };

    const canonical = JSON.stringify(req.action, Object.keys(req.action).sort());
    const buffer = Buffer.from(canonical, 'utf-8');
    const publicKeyBuf = Buffer.from(publicKeyBase64, 'base64');
    const signatureBuf = Buffer.from(tokenSignature, 'base64');

    try {
      const isValid = cryptoVerify(null, buffer, publicKeyBuf, signatureBuf);
      if (isValid) {
        req.status = 'approved';
        req.signature = tokenSignature;
        return { valid: true };
      } else {
        return { valid: false, reason: 'invalid_signature' };
      }
    } catch {
      return { valid: false, reason: 'crypto_error' };
    }
  }

  static generateKeyPair(): { publicKey: string; privateKey: string } {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    return {
      publicKey: publicKey.toString('base64'),
      privateKey: privateKey.toString('base64'),
    };
  }

  static signAction(action: HitlActionDetails, privateKeyBase64: string): string {
    const canonical = JSON.stringify(action, Object.keys(action).sort());
    const buffer = Buffer.from(canonical, 'utf-8');
    const privateKeyBuf = Buffer.from(privateKeyBase64, 'base64');
    const signature = cryptoSign(null, buffer, {
      key: privateKeyBuf,
      format: 'der',
      type: 'pkcs8',
    });
    return signature.toString('base64');
  }

  private generateApprovalId(): string {
    return `hitl-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}
