/** Client-side tests: the message built for a 402, the checks before signing, and a real local signature. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Account, RpcProvider, ec, typedData as snTypedData } from 'starknet';
import { assertIntent, buildTypedData, chooseRequirements, signPayment } from '../payment.js';

const ASSET = '0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343';
const PAY_TO = '0x02dd1b492765c064eac4039e3841aa5f382773b598097a40073bd8b48170ab57';
const FEE_PAYER = '0x05f2e02acd59f37f1e19da7ea1db6bf31d49e6e5ba66a7f1c2f0e2ba1be36f81';
const PAYER = '0x03f16efeb2ae57f7d8befb03af08a3a370562dde15149c3506ac2038ffa9be24';
const PK = '0x1234567890abcdef';
const NOW = 1_800_000_000;

const entry = (o: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  scheme: 'exact', network: 'starknet:SN_SEPOLIA', amount: '10000', asset: ASSET, payTo: PAY_TO,
  maxTimeoutSeconds: 300, extra: { feePayer: FEE_PAYER, ...extra }, ...o,
});
const challenge = (e = entry()) => ({ x402Version: 2, resource: { url: 'http://x/y' }, accepts: [e] });
// No network is ever used: signing is local. The URL below is never contacted.
const account = (address = PAYER) =>
  new Account({ provider: new RpcProvider({ nodeUrl: 'http://127.0.0.1:9' }), address, signer: PK });

describe('choosing what to pay', () => {
  it('takes the Starknet exact entry', () => assert.equal(chooseRequirements(challenge().accepts, PAYER).amount, '10000'));
  it('refuses a forbidden feePayer before anything is signed', () => {
    for (const feePayer of ['0x0', '0x414e595f43414c4c4552', PAYER, undefined])
      assert.throws(() => chooseRequirements([entry({}, { feePayer })], PAYER), /feePayer/, String(feePayer));
  });
  it('refuses an entry for another scheme or network, or a non-decimal amount', () => {
    assert.throws(() => chooseRequirements([entry({ scheme: 'upto' })], PAYER));
    assert.throws(() => chooseRequirements([entry({ network: 'eip155:1' })], PAYER));
    assert.throws(() => chooseRequirements([entry({ amount: '0x10' })], PAYER), /base-10/);
  });
});

describe('message built for the 402', () => {
  const req = chooseRequirements([entry()], PAYER);
  it('passes its own intent check', () =>
    assert.doesNotThrow(() => assertIntent(buildTypedData(req, '0x7', NOW), req, PAYER, NOW)));
  it('is refused when it was tampered with before signing', () => {
    const tamper = (f: (td: any) => void) => {
      const td = buildTypedData(req, '0x7', NOW); f(td);
      assert.throws(() => assertIntent(td, req, PAYER, NOW), /refusing to sign/);
    };
    tamper((td) => { td.message.Caller = '0x414e595f43414c4c4552'; });
    tamper((td) => { td.message.Calls[0].Calldata[1] = '0x2711'; });
    tamper((td) => { td.message.Calls[0].Calldata[2] = '0x1'; });
    tamper((td) => { td.message.Calls[0].Calldata[0] = '0x99'; });
    tamper((td) => { td.message.Calls[0].To = '0x99'; });
    tamper((td) => { td.message.Calls.push(td.message.Calls[0]); });
    tamper((td) => { td.message['Execute Before'] = String(NOW + 301); });
    tamper((td) => { td.domain.chainId = 'SN_MAIN'; });
    tamper((td) => { td.domain.revision = '0'; });
  });
});

describe('signed payment', () => {
  it('carries the registered payload shape and a signature valid for the account key', async () => {
    const acc = account();
    const pay = await signPayment(acc, challenge(), NOW, '0x71b7');
    assert.equal(pay.x402Version, 2);
    assert.deepEqual(pay.accepted, entry());
    assert.equal(pay.payload.from, PAYER);
    const { typedData, signature } = pay.payload.outsideExecution;
    assert.equal(signature.length, 2);
    const h = snTypedData.getMessageHash(typedData, PAYER);
    const pub = ec.starkCurve.getPublicKey(PK.replace(/^0x/, '').padStart(64, '0'), false);
    const [r, sg] = signature.map((x: string) => BigInt(x));
    assert.equal(ec.starkCurve.verify(new ec.starkCurve.Signature(r, sg), h.replace(/^0x/, '').padStart(64, '0'), pub), true);
  });

  it('uses a fresh nonce on every payment and survives JSON transport', async () => {
    const a = await signPayment(account(), challenge(), NOW);
    const b = await signPayment(account(), challenge(), NOW);
    assert.notEqual(a.payload.outsideExecution.typedData.message.Nonce, b.payload.outsideExecution.typedData.message.Nonce);
    assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
  });

  it('refuses to sign when the feePayer is the payer itself', async () => {
    await assert.rejects(signPayment(account(FEE_PAYER), challenge()), /feePayer/);
  });
});
