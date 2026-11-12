/** /verify and /supported against a fake Chain: every rule of the scheme, no network. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'starknet';
import { Unavailable, eventsOf } from '../chain.js';
import { supported, verifyPayment } from '../verify.js';
import { hex } from '../scheme.js';
import {
  ASSET, AMOUNT, FEE_PAYER, KEY, NOW, PAY_TO, PAYER, body, deps, keyed, legacy, requirements, typedData, world,
} from './helpers.js';

describe('/supported', () => {
  it('announces the executor as feePayer, in the registered shape', () => {
    assert.deepEqual(supported(deps(world())), {
      kinds: [{ x402Version: 2, scheme: 'exact', network: 'starknet:SN_SEPOLIA', extra: { feePayer: FEE_PAYER.replace('0x05f2', '0x5f2') } }],
      extensions: [],
      signers: { 'starknet:*': [FEE_PAYER.replace('0x05f2', '0x5f2')] },
    });
  });
});

describe('/verify', () => {
  it('accepts a valid payment and echoes the verified payer', async () => {
    const w = world();
    const out: any = await verifyPayment(deps(w), body());
    assert.deepEqual(out, { isValid: true, payer: hex(BigInt(PAYER)) });
    assert.deepEqual(w.calls, ['is_valid_signature', 'is_valid_outside_execution_nonce', 'balance_of']);
  });

  it('falls back to balanceOf', async () => {
    const out: any = await verifyPayment(deps(world({ getters: 'balanceOf' })), body());
    assert.equal(out.isValid, true);
  });

  it('refuses a token exposing neither balance getter', async () => {
    const out: any = await verifyPayment(deps(world({ getters: 'none' })), body());
    assert.equal(out.invalidReason, 'invalid_payment_requirements');
  });

  const rejected: [string, () => Promise<any>, string][] = [
    ['the pre-scheme payload shape', () => verifyPayment(deps(world()),
      { payload: { payload: { authorization: {}, outsideTransaction: {} } }, requirements: requirements() }), 'invalid_payload'],
    ['ANY_CALLER as Caller', () => verifyPayment(deps(world()),
      body(typedData({ caller: '0x414e595f43414c4c4552' }))), 'invalid_exact_starknet_payload_caller'],
    ['an underpayment', () => verifyPayment(deps(world()), body(typedData({ amount: AMOUNT - 1n }))),
      'invalid_exact_starknet_payload_amount_mismatch'],
    ['an expired authorization', () => verifyPayment(deps(world()), body(typedData({ before: Number(NOW) + 10 }))), 'outside_execution_expired'],
    ['a feePayer the facilitator does not announce', () => verifyPayment(deps(world()),
      body(typedData(), requirements({}, { feePayer: '0x1234' }))), 'invalid_payment_requirements'],
    ['accepted that differs from the requirements', () => verifyPayment(deps(world()),
      body(typedData(), requirements(), PAYER, requirements({ amount: '1' }))), 'invalid_payload'],
    ['an undeployed account', () => verifyPayment(deps(world({ deployed: false })), body()), 'account_not_deployed'],
    ['an invalid signature', () => verifyPayment(deps(world({ signature: 'invalid' })), body()),
      'invalid_exact_starknet_payload_signature'],
    ['a consumed nonce', () => verifyPayment(deps(world({ nonceFree: false })), body()), 'nonce_already_used'],
    ['an insufficient balance', () => verifyPayment(deps(world({ balance: AMOUNT - 1n })), body()), 'insufficient_funds'],
    ['a reverted simulation', () => verifyPayment(deps(world({ events: 'reverted' })), body()), 'simulation_failed'],
    ['a simulation with no transfer', () => verifyPayment(deps(world({ events: [] })), body()), 'simulation_failed'],
    ['a simulated transfer to someone else', () => verifyPayment(deps(world({ events: [keyed(PAYER, '0x99', AMOUNT)] })), body()),
      'simulation_failed'],
    ['a simulated transfer of another amount', () => verifyPayment(deps(world({ events: [keyed(PAYER, PAY_TO, AMOUNT + 1n)] })), body()),
      'simulation_failed'],
    ['two payer transfers', () => verifyPayment(deps(world({ events: [keyed(PAYER, PAY_TO, AMOUNT), keyed(PAYER, '0x99', 5n)] })), body()),
      'simulation_failed'],
    ['a Transfer event that fits no layout', () => verifyPayment(deps(world({ events: [{ from_address: ASSET, keys: [KEY, PAYER], data: [] }] })), body()),
      'simulation_failed'],
    ['a transfer emitted by another contract', () => verifyPayment(deps(world({ events: [keyed(PAYER, PAY_TO, AMOUNT, '0x1')] })), body()),
      'simulation_failed'],
    ['a node on another network', () => verifyPayment(deps(world({ chainId: constants.StarknetChainId.SN_MAIN })), body()),
      'unexpected_verify_error'],
  ];
  for (const [name, run, code] of rejected) {
    it(`rejects ${name}`, async () => {
      const out = await run();
      assert.equal(out.isValid, false);
      assert.equal(out.invalidReason, code);
    });
  }

  it('counts the legacy unkeyed Transfer layout', async () => {
    const out: any = await verifyPayment(deps(world({ events: [legacy(PAYER, PAY_TO, AMOUNT)] })), body());
    assert.equal(out.isValid, true);
  });

  it("ignores other senders' Transfers, such as the executor fee", async () => {
    const events = [keyed(FEE_PAYER, '0x77', 123n), keyed(PAYER, PAY_TO, AMOUNT)];
    const out: any = await verifyPayment(deps(world({ events })), body());
    assert.equal(out.isValid, true);
  });

  it('fails closed on transport errors and never emits a payment-state code', async () => {
    for (const w of [world({ signature: 'throw' }), world({ nonceFree: 'throw' }), world({ events: 'unavailable' })]) {
      const out: any = await verifyPayment(deps(w), body());
      assert.equal(out.isValid, false);
      assert.equal(out.invalidReason, 'unexpected_verify_error');
    }
  });

  it('echoes payer only once the signature was verified, and never leaks raw error text', async () => {
    const before: any = await verifyPayment(deps(world({ signature: 'invalid' })), body());
    assert.equal('payer' in before, false);
    const after: any = await verifyPayment(deps(world({ nonceFree: false })), body());
    assert.equal(after.payer, hex(BigInt(PAYER)));
    const logs: string[] = [];
    const err: any = await verifyPayment(deps(world({ events: 'unavailable' }), { log: (m) => logs.push(m) }), body());
    assert.deepEqual(Object.keys(err).sort(), ['invalidReason', 'isValid', 'payer']);
    assert.match(logs[0], /unreadable trace/);
  });

  it('applies the optional asset / recipient allow-list', async () => {
    const a: any = await verifyPayment(deps(world(), { asset: 0x1n }), body());
    const b: any = await verifyPayment(deps(world(), { payTo: 0x1n }), body());
    assert.equal(a.invalidReason, 'invalid_payment_requirements');
    assert.equal(b.invalidReason, 'invalid_payment_requirements');
    const ok: any = await verifyPayment(deps(world(), { asset: BigInt(ASSET), payTo: BigInt(PAY_TO) }), body());
    assert.equal(ok.isValid, true);
  });
});

describe('trace events', () => {
  it('attributes every event to the contract of its enclosing frame', () => {
    const events = eventsOf({
      contract_address: '0xa', events: [{ keys: ['0x1'], data: [] }],
      calls: [{ contract_address: '0xb', events: [{ keys: ['0x2'], data: ['0x3'] }], calls: [] }],
    });
    assert.deepEqual(events.map((e) => [e.from_address, e.keys[0]]), [['0xa', '0x1'], ['0xb', '0x2']]);
  });
  it('refuses an unreadable frame instead of guessing', () => {
    assert.throws(() => eventsOf({ contract_address: '0xa' } as any), Unavailable);
  });
});

