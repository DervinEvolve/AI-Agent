import { expect, it } from 'vitest';
import * as http from 'node:http';
import type { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { LiveModelTransport } from '../live_model_transport';

it('sends the exact authorized UTF-8 serialization and collects a fragmented successful response without credentials', async () => {
  const sockets = new Set<Socket>();
  const requestBodies: Buffer[] = [];
  const authorizationHeaders: Array<string | undefined> = [];
  const authorizedBodies: Buffer[] = [];
  const responseText = JSON.stringify({ content: 'A café and a snowman ☃' });
  const responseBytes = Buffer.from(responseText, 'utf8');
  // Split inside a multibyte character, not merely between JSON tokens.
  const split = responseBytes.indexOf(Buffer.from('☃')) + 1;
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    authorizationHeaders.push(req.headers.authorization);
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      requestBodies.push(Buffer.concat(chunks));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write(responseBytes.subarray(0, split));
      res.end(responseBytes.subarray(split));
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  let transport: LiveModelTransport | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
    transport = new LiveModelTransport({
      endpoint: `http://127.0.0.1:${address.port}/chat`,
      fixtureMode: true,
      deadlineMs: performance.now() + 15000,
      finalizationReserveMs: 100,
      maxRequestBytes: 4096,
      authorizeDisclosure: bytes => {
        authorizedBodies.push(Buffer.from(bytes));
        return true;
      },
    });
    const payload = {
      messages: [{ role: 'user', content: 'Preserve café, ☃, and "quoted" text' }],
      stream: false,
    };
    const result = await transport.send(payload);
    const expectedBytes = Buffer.from(JSON.stringify(payload), 'utf8');

    expect(result).toBe(responseText);
    expect(JSON.parse(result)).toEqual({ content: 'A café and a snowman ☃' });
    expect(requests).toBe(1);
    expect(authorizationHeaders).toEqual([undefined]);
    expect(authorizedBodies).toEqual([expectedBytes]);
    expect(requestBodies).toEqual([expectedBytes]);
  } finally {
    transport?.close();
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }
  }
}, 20000);
