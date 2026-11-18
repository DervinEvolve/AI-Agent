import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import { performance } from 'node:perf_hooks';
import { LiveModelTransport, LiveTransportConfig } from '../live_model_transport';

function config(overrides: Partial<LiveTransportConfig> = {}): LiveTransportConfig {
  return {
    endpoint: 'http://127.0.0.1:1/', fixtureMode: true,
    deadlineMs: performance.now() + 10000, finalizationReserveMs: 0,
    maxRequestBytes: 1024, authorizeDisclosure: () => true, ...overrides,
  };
}

describe('live transport boundary', () => {
  it('rejects absent live credentials and unavailable shared integration', () => {
    expect(() => new LiveModelTransport(config({ endpoint: 'https://example.invalid', fixtureMode: false, credential: '  ' }))).toThrow('CREDENTIAL_REQUIRED');
    expect(() => new LiveModelTransport(config({ requireSharedDeniedBytes: true }))).toThrow('CONFIGURATION');
    expect(() => new LiveModelTransport(config({ credential: 'never-send' }))).toThrow('CONFIGURATION');
  });

  it('enforces serialized size, disclosure, denied bytes and deadline before sockets', async () => {
    await expect(new LiveModelTransport(config({ maxRequestBytes: 1 })).send({})).rejects.toThrow('REQUEST_TOO_LARGE');
    await expect(new LiveModelTransport(config({ authorizeDisclosure: () => false })).send({})).rejects.toThrow('DISCLOSURE_DENIED');
    await expect(new LiveModelTransport(config({ deniedExactBytes: [Buffer.from('secret')] })).send({ value: 'secret' })).rejects.toThrow('DISCLOSURE_DENIED');
    await expect(new LiveModelTransport(config({ deadlineMs: 0 })).send({})).rejects.toThrow('DEADLINE');
  });

  for (const status of [200, 302, 429, 500]) {
    it(`makes one attempt and protects echoed output at status ${status}`, async () => {
      const sentinel = 'fixture-only-sensitive-value';
      let requests = 0;
      let authorization: string | undefined;
      const sockets = new Set<import('node:net').Socket>();
      const server = http.createServer((request, response) => {
        requests++;
        authorization = request.headers.authorization;
        request.resume();
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ echo: sentinel }));
      });
      server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      let transport: LiveModelTransport | undefined;
      try {
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address() as import('node:net').AddressInfo;
        transport = new LiveModelTransport(config({ endpoint: `http://127.0.0.1:${address.port}/`, protectedValues: [sentinel] }));
        let failure: unknown;
        try { await transport.send({ messages: [] }); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(status === 200 ? 'PROTECTED_OUTPUT' : 'HTTP_STATUS');
        expect(String(failure) + JSON.stringify(failure) + (failure as Error).stack).not.toContain(sentinel);
        expect(requests).toBe(1);
        expect(authorization).toBeUndefined();
      } finally {
        transport?.close();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });
  }
});
