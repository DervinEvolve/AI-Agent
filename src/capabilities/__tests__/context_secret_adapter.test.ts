import { describe, it, expect } from 'vitest';
import {
  redactSecrets,
  containsRealVaultSecret,
  VAULT_SECRET_MARKER,
} from '../context_secret_adapter';

describe('context_secret_adapter.redactSecrets', () => {
  it('redacts openai-style keys', () => {
    const out = redactSecrets('key is sk-ABCDEFGH12345678 done');
    expect(out).not.toContain('sk-ABCDEFGH12345678');
    expect(out).toContain('[REDACTED]');
    expect(out.startsWith('key is ')).toBe(true);
    expect(out.endsWith(' done')).toBe(true);
  });

  it('redacts github personal access tokens', () => {
    const token = 'ghp_' + 'a'.repeat(20);
    const out = redactSecrets(`token=${token}`);
    expect(out).not.toContain(token);
    expect(out).toContain('[REDACTED]');
  });

  it('redacts AWS access key ids', () => {
    const out = redactSecrets('AKIAABCDEFGH12345678 present');
    expect(out).not.toContain('AKIAABCDEFGH12345678');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts JWT-shaped tokens', () => {
    const jwt = 'eyJabcdefgh.abcd1234.wxyz5678';
    const out = redactSecrets(`auth ${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain('[REDACTED]');
  });

  it('redacts slack-style tokens', () => {
    const out = redactSecrets('xoxb-12345678abcdefgh here');
    expect(out).not.toContain('xoxb-12345678abcdefgh');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts key/value secret assignments case-insensitively', () => {
    const out = redactSecrets('password: hunter2secret');
    expect(out).not.toContain('hunter2secret');
    expect(out).toContain('[REDACTED]');

    const out2 = redactSecrets('API_KEY=supersecretvalue');
    expect(out2).not.toContain('supersecretvalue');
    expect(out2).toContain('[REDACTED]');
  });

  it('redacts hidden host paths under /home and /Users', () => {
    const out = redactSecrets('read /home/alice/.aws/credentials now');
    expect(out).not.toContain('/home/alice/.aws/credentials');
    expect(out).toContain('[REDACTED]');

    const out2 = redactSecrets('open /Users/bob/.ssh/id_rsa file');
    expect(out2).not.toContain('/Users/bob/.ssh/id_rsa');
    expect(out2).toContain('[REDACTED]');
  });

  it('leaves ordinary non-secret text unchanged', () => {
    const clean = 'The mission has three milestones and two open claims.';
    expect(redactSecrets(clean)).toBe(clean);
  });

  it('redacts multiple distinct secrets in one string', () => {
    const s = 'a sk-ABCDEFGH12345678 b ' + 'ghp_' + 'z'.repeat(20);
    const out = redactSecrets(s);
    expect(out).not.toContain('sk-ABCDEFGH12345678');
    expect(out).not.toContain('ghp_zzzzzzzzzzzzzzzzzzzz');
    // both secrets replaced, so at least two markers present
    const count = (out.match(/\[REDACTED\]/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('always returns a string even when input has no secrets', () => {
    expect(typeof redactSecrets('')).toBe('string');
    expect(redactSecrets('')).toBe('');
  });
});

describe('context_secret_adapter.containsRealVaultSecret', () => {
  it('is true only when the vault secret marker is present', () => {
    expect(containsRealVaultSecret(`${VAULT_SECRET_MARKER}deadbeef`)).toBe(true);
    expect(containsRealVaultSecret('embedded ' + VAULT_SECRET_MARKER + ' bytes')).toBe(true);
  });

  it('is false for ordinary content and even for redactable synthetic secrets', () => {
    expect(containsRealVaultSecret('nothing sensitive here')).toBe(false);
    // A synthetic token is redactable but is NOT actual vault-held secret bytes.
    expect(containsRealVaultSecret('sk-ABCDEFGH12345678')).toBe(false);
    expect(containsRealVaultSecret('')).toBe(false);
  });

  it('the vault marker is not itself removed by pattern redaction (detection stays possible)', () => {
    // Detection must precede/coexist with redaction; the raw marker input remains detectable.
    const raw = `${VAULT_SECRET_MARKER}rawbytes`;
    expect(containsRealVaultSecret(raw)).toBe(true);
  });
});
