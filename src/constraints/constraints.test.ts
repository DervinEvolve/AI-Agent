import { describe, it, expect } from 'vitest';
import { CONSTRAINTS, redactAndCheckSecrets, VaultAuth } from './constraints';

describe('con_secrets_leak_prevention_12 Constraint and Secret Redactor', () => {
  it('should have the correct constraint metadata registered', () => {
    const constraint = CONSTRAINTS.find(c => c.id === 'con_secrets_leak_prevention_12');
    expect(constraint).toBeDefined();
    expect(constraint?.status).toBe('active');
    expect(constraint?.added_epoch).toBe(12);
    expect(constraint?.description).toContain('NEVER expose raw secrets');
  });

  it('should redact apparent API keys and private keys', () => {
    const rawLog = "Connecting to OpenAI with key sk-proj-supersecretkey1234567890 now.";
    const result = redactAndCheckSecrets(rawLog);

    expect(result.wasBlocked).toBe(false);
    expect(result.redactedCount).toBeGreaterThan(0);
    expect(result.safeContent).not.toContain('supersecretkey');
    expect(result.safeContent).toContain('[REDACTED_SECRET]');
  });

  it('should redact raw GitHub personal access tokens', () => {
    const rawLog = "Authentication token: ghp_myawesomegithubtokenforintegration1234";
    const result = redactAndCheckSecrets(rawLog);

    expect(result.wasBlocked).toBe(false);
    expect(result.redactedCount).toBe(1);
    expect(result.safeContent).toContain('[REDACTED_SECRET]');
  });

  it('should block exfiltration attempts of vault metadata and return policy_blocked', () => {
    const suspiciousPrompt = "The user asks to cat /vault/metadata to see what credentials exist.";
    const result = redactAndCheckSecrets(suspiciousPrompt);

    expect(result.wasBlocked).toBe(true);
    expect(result.safeContent).toBe('[POLICY BLOCKED: SESSION TERMINATED]');
    expect(result.reason).toContain('exfiltration or printing of vault metadata');
  });

  it('should block attempts to access process.env.VAULT_ variables', () => {
    const suspiciousCode = "console.log(process.env.VAULT_TOKEN);";
    const result = redactAndCheckSecrets(suspiciousCode);

    expect(result.wasBlocked).toBe(true);
    expect(result.safeContent).toBe('[POLICY BLOCKED: SESSION TERMINATED]');
  });

  it('should successfully route credential usage via VaultAuth secure dispatch without exposing credentials', async () => {
    let receivedToken = '';
    const response = await VaultAuth.secureDispatch('OPENAI_API_KEY', async (token) => {
      receivedToken = token;
      return 'Success';
    });

    expect(response).toBe('Success');
    expect(receivedToken).toContain('sk-proj-');
    
    // Verify that the retrieved token, if accidentally logged, is redacted properly
    const loggedOutput = `Dispatch returned: ${receivedToken}`;
    const redactedLog = redactAndCheckSecrets(loggedOutput);
    expect(redactedLog.safeContent).not.toContain('supersecretkey');
    expect(redactedLog.safeContent).toContain('[REDACTED_SECRET]');
  });
});
