/**
 * Mock delegated auth vault mimicking cap_delegated_auth_vault_12.
 * Provides deterministic keys and signing derivations.
 */
import * as crypto from 'crypto';

export class DelegatedAuthVault12 {
  static deriveSigningKey(scope: { user_id: string; project_id: string; namespace: string }, agentId: string): string {
    const material = `${scope.user_id}:${scope.project_id}:${scope.namespace}:${agentId}`;
    return crypto.createHash('sha256').update(material).digest('hex');
  }

  static signPayload(signingKey: string, payload: any): string {
    const payloadString = JSON.stringify(payload);
    return crypto.createHmac('sha256', signingKey).update(payloadString).digest('hex');
  }

  static verifySignature(signingKey: string, payload: any, signature: string): boolean {
    const expected = this.signPayload(signingKey, payload);
    return expected === signature;
  }
}
