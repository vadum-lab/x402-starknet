/**
 * Black-box tests of the example server: the real server.ts runs in a child process against a fake
 * facilitator on localhost, which records what the server asks it to check.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRICE = '50000000000000000';
const PAY_TO = '0x2dd1b492765c064eac4039e3841aa5f382773b598097a40073bd8b48170ab57';

const listen = (server: Server) =>
  new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

const paymentHeader = (payment: unknown) => Buffer.from(JSON.stringify(payment)).toString('base64');

describe('example server', () => {
  let facilitator: Server;
  let child: ChildProcess;
  let base: string;
  let received: { path: string; body: any }[] = [];

  const paidRequest = (payment: unknown) =>
    fetch(`${base}/x402/hello`, { method: 'POST', headers: { 'PAYMENT-SIGNATURE': paymentHeader(payment) } });

  before(async () => {
    facilitator = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        received.push({ path: req.url!, body: JSON.parse(raw) });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(req.url === '/verify' ? { valid: true } : { success: true, txHash: '0xabc' }));
      });
    });
    const facilitatorPort = await listen(facilitator);

    const probe = createServer();
    const port = await listen(probe);
    await new Promise((r) => probe.close(r));
    base = `http://127.0.0.1:${port}`;

    child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
      cwd: join(dirname(fileURLToPath(import.meta.url)), '..'),
      env: {
        ...process.env, PORT: String(port), FACILITATOR_URL: `http://127.0.0.1:${facilitatorPort}`,
        X402_PAY_TO: PAY_TO, X402_AMOUNT: PRICE,
      },
      stdio: 'ignore',
    });

    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${base}/health`)).ok) break;
      } catch { /* not listening yet */ }
      if (i > 150) throw new Error('server did not start');
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  after(async () => {
    child?.kill();
    await new Promise((r) => facilitator.close(r));
  });

  beforeEach(() => { received = []; });

  it('answers 402 with its own price when no payment is presented', async () => {
    const res = await fetch(`${base}/x402/hello`, { method: 'POST' });
    assert.equal(res.status, 402);
    const out = await res.json();
    assert.equal(out.accepts[0].amount, PRICE);
    assert.equal(received.length, 0);
  });

  it('checks a payment against its own price, not the one the client sends', async () => {
    const res = await paidRequest({ payload: { any: 'payload' }, requirements: { amount: '1', payTo: '0xbad' } });
    assert.equal(res.status, 200);
    assert.deepEqual(received.map((r) => r.path), ['/verify', '/settle']);
    for (const { body } of received) {
      assert.equal(body.requirements.amount, PRICE);
      assert.equal(body.requirements.payTo, PAY_TO);
      assert.deepEqual(body.payload, { any: 'payload' });
    }
  });
});
