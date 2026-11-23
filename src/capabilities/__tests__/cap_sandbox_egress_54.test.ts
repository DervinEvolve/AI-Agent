import { describe, expect, it } from 'vitest';
import {
  classifyIpAddress,
  classifySandboxTimeoutOutcome,
  evaluateSandboxEgressRequest,
  freezeSandboxEgressPolicy,
  getSandboxDockerNetworkArgs,
  getSandboxToolRegistrationOverrides,
  isChildEgressAllowed,
  SandboxEgressRecorder,
} from '../cap_sandbox_egress_54.js';

describe('cap_sandbox_egress_54', () => {
  it('preserves --network=none and default registration when profile is none or absent', () => {
    const policy = freezeSandboxEgressPolicy();
    expect(policy.profile).toBe('none');
    expect(Object.isFrozen(policy)).toBe(true);
    expect(getSandboxDockerNetworkArgs(policy)).toEqual(['--network=none']);
    expect(getSandboxToolRegistrationOverrides(policy)).toBeUndefined();
    expect(isChildEgressAllowed(policy)).toBe(false);
  });

  it('classifies loopback, RFC1918, CGNAT, link-local, metadata, and IPv4-mapped IPv6 as private/reserved', () => {
    expect(classifyIpAddress('127.0.0.1').isPrivateOrReserved).toBe(true);
    expect(classifyIpAddress('10.0.0.5').isPrivateOrReserved).toBe(true);
    expect(classifyIpAddress('172.16.0.1').isPrivateOrReserved).toBe(true);
    expect(classifyIpAddress('192.168.1.1').isPrivateOrReserved).toBe(true);
    expect(classifyIpAddress('100.64.0.1').isPrivateOrReserved).toBe(true);
    expect(classifyIpAddress('169.254.169.254').isPrivateOrReserved).toBe(true);
    expect(classifyIpAddress('::1').isPrivateOrReserved).toBe(true);
    expect(classifyIpAddress('::ffff:127.0.0.1').isPrivateOrReserved).toBe(true);
    expect(classifyIpAddress('::ffff:7f00:1').isPrivateOrReserved).toBe(true);
    expect(classifyIpAddress('fd00:ec2::254').isPrivateOrReserved).toBe(true);
    expect(classifyIpAddress('93.184.216.34').isPrivateOrReserved).toBe(false);
  });

  it('permits allowlisted host/port/method/path and pins to first validated IP', async () => {
    const policy = freezeSandboxEgressPolicy({
      profile: 'allowlist',
      allowlist: [
        {
          host: 'registry.npmjs.org',
          pathPrefixes: ['/vitest'],
        },
      ],
    });

    const decision = await evaluateSandboxEgressRequest(
      policy,
      { callId: 'c1', url: 'https://registry.npmjs.org/vitest', method: 'GET' },
      { resolveDns: async () => ['104.16.1.1', '104.16.2.2'] },
    );

    expect(decision.allowed).toBe(true);
    expect(decision.pinnedIp).toBe('104.16.1.1');
  });

  it('denies mixed public and private DNS answer sets', async () => {
    const policy = freezeSandboxEgressPolicy({
      profile: 'allowlist',
      allowlist: [{ host: 'example.com' }],
    });

    const decision = await evaluateSandboxEgressRequest(
      policy,
      { callId: 'c2', url: 'https://example.com/', method: 'GET' },
      { resolveDns: async () => ['93.184.216.34', '10.0.0.1'] },
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('dns_denied');
  });

  it('denies unlisted hosts, non-443 ports, disallowed methods, bodies, queries, and CONNECT without opt-in', async () => {
    const policy = freezeSandboxEgressPolicy({
      profile: 'allowlist',
      allowlist: [{ host: 'pypi.org', maxUrlBytes: 64 }],
    });
    const resolveDns = async () => ['151.101.0.223'];

    expect(
      (await evaluateSandboxEgressRequest(policy, { callId: 'c3', url: 'https://evil.com/', method: 'GET' }, { resolveDns })).allowed,
    ).toBe(false);
    expect(
      (await evaluateSandboxEgressRequest(policy, { callId: 'c4', url: 'https://pypi.org:8443/', method: 'GET' }, { resolveDns })).allowed,
    ).toBe(false);
    expect(
      (await evaluateSandboxEgressRequest(policy, { callId: 'c5', url: 'https://pypi.org/', method: 'POST' }, { resolveDns })).allowed,
    ).toBe(false);
    expect(
      (await evaluateSandboxEgressRequest(policy, { callId: 'c6', url: 'https://pypi.org/', method: 'GET', hasBody: true }, { resolveDns })).allowed,
    ).toBe(false);
    expect(
      (await evaluateSandboxEgressRequest(policy, { callId: 'c7', url: 'https://pypi.org/?q=1', method: 'GET' }, { resolveDns })).allowed,
    ).toBe(false);
    expect(
      (await evaluateSandboxEgressRequest(policy, { callId: 'c8', url: 'https://pypi.org/', method: 'CONNECT' }, { resolveDns })).allowed,
    ).toBe(false);
  });

  it('enforces egressAuthorizer and fails closed when required authorizer is missing', async () => {
    const missingAuthPolicy = freezeSandboxEgressPolicy({
      profile: 'allowlist',
      allowlist: [{ host: 'pypi.org' }],
      requireAuthorizer: true,
    });
    const resMissing = await evaluateSandboxEgressRequest(
      missingAuthPolicy,
      { callId: 'c9', url: 'https://pypi.org/', method: 'GET' },
      { resolveDns: async () => ['151.101.0.223'] },
    );
    expect(resMissing.allowed).toBe(false);
    expect(resMissing.reason).toBe('authorizer_missing');

    const denyAuthPolicy = freezeSandboxEgressPolicy({
      profile: 'allowlist',
      allowlist: [{ host: 'pypi.org' }],
      egressAuthorizer: () => false,
    });
    const resDenied = await evaluateSandboxEgressRequest(
      denyAuthPolicy,
      { callId: 'c10', url: 'https://pypi.org/', method: 'GET' },
      { resolveDns: async () => ['151.101.0.223'] },
    );
    expect(resDenied.allowed).toBe(false);
    expect(resDenied.reason).toBe('authorizer_denied');
  });

  it('enforces non-idempotent registration, unknown timeout, child egress gating, and bounded non-citable records', () => {
    const policy = freezeSandboxEgressPolicy({
      profile: 'allowlist',
      allowlist: [{ host: 'pypi.org' }],
      allowChildEgress: false,
    });

    expect(() => getSandboxDockerNetworkArgs(policy)).toThrow();
    expect(getSandboxToolRegistrationOverrides(policy)).toEqual({
      idempotent: false,
      concurrentSafe: false,
    });
    expect(classifySandboxTimeoutOutcome(policy)).toEqual({
      outcome: 'unknown',
      autoRetry: false,
    });
    expect(isChildEgressAllowed(policy)).toBe(false);

    const recorder = new SandboxEgressRecorder(1);
    recorder.record({
      call_id: 'c1',
      host: 'pypi.org',
      port: 443,
      method: 'GET',
      decision: 'allow',
      reason: 'allowed',
      timestampMs: 1000,
    });
    recorder.record({
      call_id: 'c2',
      host: 'evil.com',
      port: 443,
      method: 'GET',
      decision: 'deny',
      reason: 'host_not_allowlisted',
      timestampMs: 1001,
    });
    const snap = recorder.snapshot();
    expect(snap.records.length).toBe(1);
    expect(snap.elidedCount).toBe(1);
    expect(snap.nonCitable).toBe(true);
  });
});
