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
const FEE_PAYER = '0x5f2e02acd59f37f1e19da7ea1db6bf31d49e6e5ba66a7f1c2f0e2ba1be36f81';
const NETWORK = 'starknet:SN_SEPOLIA';

const listen = (server: Server) =>
  new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
const decode = (h: string | null) => JSON.parse(Buffer.from(h!, 'base64').toString('utf8'));

describe('example server', () => {
  let facilitator: Server;
  let child: ChildProcess;
  let base: string;
  let received: { path: string; body: any }[] = [];
  let answers: Record<string, unknown> = {};

  const paidRequest = (payment: unknown) =>
    fetch(`${base}/x402/hello`, { method: 'POST', headers: { 'PAYMENT-SIGNATURE': b64(payment) } });

  before(async () => {
    facilitator = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/supported') {
          return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK, extra: { feePayer: FEE_PAYER } }] }));
        }
        received.push({ path: req.url!, body: JSON.parse(raw) });
        res.end(JSON.stringify(answers[req.url!]));
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

  beforeEach(() => {
    received = [];
    answers = {
      '/verify': { isValid: true, payer: '0x3f' },
      '/settle': { success: true, transaction: '0xabc', network: NETWORK, payer: '0x3f' },
    };
  });

  it('answers 402 with PAYMENT-REQUIRED: its own price and the facilitator feePayer, verbatim', async () => {
    const res = await fetch(`${base}/x402/hello`, { method: 'POST' });
    assert.equal(res.status, 402);
    const header = decode(res.headers.get('PAYMENT-REQUIRED'));
    assert.deepEqual(header, await res.json());
    assert.equal(header.x402Version, 2);
    assert.match(header.resource.url, /\/x402\/hello$/);
    assert.deepEqual(header.accepts[0], {
      scheme: 'exact', network: NETWORK, amount: PRICE,
      asset: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
      payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { feePayer: FEE_PAYER },
    });
    assert.equal(received.length, 0);
  });

  it('checks a payment against its own requirements, not the ones the client sends', async () => {
    const res = await paidRequest({ x402Version: 2, accepted: { amount: '1', payTo: '0xbad' }, payload: { any: 'payload' } });
    assert.equal(res.status, 200);
    assert.deepEqual(received.map((r) => r.path), ['/verify', '/settle']);
    for (const { body } of received) {
      assert.equal(body.x402Version, 2);
      assert.equal(body.paymentRequirements.amount, PRICE);
      assert.equal(body.paymentRequirements.payTo, PAY_TO);
      assert.equal(body.paymentRequirements.extra.feePayer, FEE_PAYER);
      assert.deepEqual(body.paymentPayload.payload, { any: 'payload' });
    }
  });

  it('serves the resource with PAYMENT-RESPONSE once settled', async () => {
    const res = await paidRequest({ x402Version: 2, payload: {} });
    assert.equal(res.status, 200);
    assert.equal(decode(res.headers.get('PAYMENT-RESPONSE')).transaction, '0xabc');
    assert.equal((await res.json()).transaction, '0xabc');
  });

  it('does not settle, and does not serve, an invalid payment', async () => {
    answers['/verify'] = { isValid: false, invalidReason: 'insufficient_funds' };
    const res = await paidRequest({ x402Version: 2, payload: {} });
    assert.equal(res.status, 402);
    assert.equal((await res.json()).error, 'insufficient_funds');
    assert.deepEqual(received.map((r) => r.path), ['/verify']);
  });

  it('answers 400 to a malformed payment and 500 to an unexpected facilitator error', async () => {
    answers['/verify'] = { isValid: false, invalidReason: 'invalid_payload' };
    assert.equal((await paidRequest({})).status, 400);
    answers['/verify'] = { isValid: false, invalidReason: 'unexpected_verify_error' };
    assert.equal((await paidRequest({})).status, 500);
    const bad = await fetch(`${base}/x402/hello`, { method: 'POST', headers: { 'PAYMENT-SIGNATURE': '%%%' } });
    assert.equal(bad.status, 400);
  });

  it('does not serve a failed settlement, and exposes a pending one with its hash', async () => {
    answers['/settle'] = { success: false, errorReason: 'invalid_transaction_state', transaction: '0xabc', network: NETWORK };
    let res = await paidRequest({ x402Version: 2, payload: {} });
    assert.equal(res.status, 402);
    assert.equal(res.headers.get('PAYMENT-RESPONSE') !== null, true);
    assert.equal('result' in (await res.json()), false);

    answers['/settle'] = { success: false, errorReason: 'settlement_pending', transaction: '0xdef', network: NETWORK };
    res = await paidRequest({ x402Version: 2, payload: {} });
    assert.equal(res.status, 402);
    assert.deepEqual(decode(res.headers.get('PAYMENT-RESPONSE')),
      { success: false, errorReason: 'settlement_pending', transaction: '0xdef', network: NETWORK });
  });
});
