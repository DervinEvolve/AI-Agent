import { describe, expect, it } from 'vitest';
import {
  classifyIpAddress,
  evaluateSandboxEgressRequest,
  freezeSandboxEgressPolicy,
  getSandboxDockerNetworkArgs,
  getSandboxToolRegistrationOverrides,
  isChildEgressAllowed,
  type DnsResolver,
} from '../cap_sandbox_egress_54.js';

describe('cap_sandbox_egress_54 policy and request evaluation', () => {
  it('freezes allowlist policy, disables child egress by default, and sets non-idempotent overrides', () => {
    const policy = freezeSandboxEgressPolicy({
      profile: 'allowlist',
      allowlist: [{ host: 'registry.npmjs.org' }],
    });

    expect(policy.profile).toBe('allowlist');
    expect(policy.frozen).toBe(true);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(isChildEgressAllowed(policy)).toBe(false);
    expect(getSandboxDockerNetworkArgs(policy)).not.toEqual(['--network=none']);
    expect(getSandboxToolRegistrationOverrides(policy)).toEqual({
      idempotent: false,
      concurrentSafe: false,
    });
  });

  it('allows child egress only when allowChildEgress is explicitly true', () => {
    const policy = freezeSandboxEgressPolicy({
      profile: 'allowlist',
      allowlist: [{ host: 'pypi.org' }],
      allowChildEgress: true,
    });

    expect(isChildEgressAllowed(policy)).toBe(true);
  });

  it('enforces host, port, method, body, query, and CONNECT rules with pinned public IP', async () => {
    const resolver: DnsResolver = async () => ['93.184.216.34', '93.184.216.35'];
    const policy = freezeSandboxEgressPolicy({
      profile: 'allowlist',
      allowlist: [
        {
          host: 'example.com',
          pathPrefixes: ['/packages/'],
        },
      ],
    });

    const allowed = await evaluateSandboxEgressRequest(
      policy,
      {
        callId: 'call-1',
        url: 'https://example.com/packages/pkg.tgz',
        method: 'GET',
      },
      resolver,
    );
    expect(allowed.allowed).toBe(true);
    expect(allowed.pinnedIp).toBe('93.184.216.34');

    const unlistedHost = await evaluateSandboxEgressRequest(
      policy,
      {
        callId: 'call-2',
        url: 'https://unlisted.example.org/packages/pkg.tgz',
        method: 'GET',
      },
      resolver,
    );
    expect(unlistedHost.allowed).toBe(false);

    const disallowedPort = await evaluateSandboxEgressRequest(
      policy,
      {
        callId: 'call-3',
        url: 'https://example.com:8443/packages/pkg.tgz',
        method: 'GET',
      },
      resolver,
    );
    expect(disallowedPort.allowed).toBe(false);

    const disallowedMethod = await evaluateSandboxEgressRequest(
      policy,
      {
        callId: 'call-4',
        url: 'https://example.com/packages/pkg.tgz',
        method: 'POST',
      },
      resolver,
    );
    expect(disallowedMethod.allowed).toBe(false);

    const withBody = await evaluateSandboxEgressRequest(
      policy,
      {
        callId: 'call-5',
        url: 'https://example.com/packages/pkg.tgz',
        method: 'GET',
        hasBody: true,
        bodyBytes: 16,
      },
      resolver,
    );
    expect(withBody.allowed).toBe(false);

    const withQuery = await evaluateSandboxEgressRequest(
      policy,
      {
        callId: 'call-6',
        url: 'https://example.com/packages/pkg.tgz?token=abc',
        method: 'GET',
      },
      resolver,
    );
    expect(withQuery.allowed).toBe(false);

    const connectRequest = await evaluateSandboxEgressRequest(
      policy,
      {
        callId: 'call-7',
        url: 'https://example.com/packages/pkg.tgz',
        method: 'CONNECT',
      },
      resolver,
    );
    expect(connectRequest.allowed).toBe(false);
  });

  it('denies mixed public and private DNS resolution results', async () => {
    const mixedResolver: DnsResolver = async () => ['93.184.216.34', '10.0.0.1'];
    const policy = freezeSandboxEgressPolicy({
      profile: 'allowlist',
      allowlist: [{ host: 'example.com' }],
    });

    const decision = await evaluateSandboxEgressRequest(
      policy,
      {
        callId: 'call-mixed',
        url: 'https://example.com/index.json',
        method: 'GET',
      },
      mixedResolver,
    );

    expect(decision.allowed).toBe(false);
    expect(classifyIpAddress('10.0.0.1').isPrivateOrReserved).toBe(true);
  });

  it('enforces requireAuthorizer and egressAuthorizer decisions', async () => {
    const resolver: DnsResolver = async () => ['93.184.216.34'];

    const missingAuthPolicy = freezeSandboxEgressPolicy({
      profile: 'allowlist',
      allowlist: [{ host: 'example.com' }],
      requireAuthorizer: true,
    });
    const missingAuthDecision = await evaluateSandboxEgressRequest(
      missingAuthPolicy,
      {
        callId: 'call-auth-missing',
        url: 'https://example.com/file',
        method: 'GET',
      },
      resolver,
    );
    expect(missingAuthDecision.allowed).toBe(false);

    const denyingAuthPolicy = freezeSandboxEgressPolicy({
      profile: 'allowlist',
      allowlist: [{ host: 'example.com' }],
      requireAuthorizer: true,
      egressAuthorizer: () => false,
    });
    const deniedDecision = await evaluateSandboxEgressRequest(
      denyingAuthPolicy,
      {
        callId: 'call-auth-deny',
        url: 'https://example.com/file',
        method: 'GET',
      },
      resolver,
    );
    expect(deniedDecision.allowed).toBe(false);

    const allowingAuthPolicy = freezeSandboxEgressPolicy({
      profile: 'allowlist',
      allowlist: [{ host: 'example.com' }],
      requireAuthorizer: true,
      egressAuthorizer: (req) => req.pinnedIp === '93.184.216.34',
    });
    const allowedDecision = await evaluateSandboxEgressRequest(
      allowingAuthPolicy,
      {
        callId: 'call-auth-allow',
        url: 'https://example.com/file',
        method: 'GET',
      },
      resolver,
    );
    expect(allowedDecision.allowed).toBe(true);
  });
});
