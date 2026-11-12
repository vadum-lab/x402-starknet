/** /settle against a fake Chain and a fake submitter: re-verification, outcome checks, duplicate cache. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RpcError } from 'starknet';
import { SettleCache, settlePayment, type SettleDeps } from '../settle.js';
import { hex } from '../scheme.js';
import {
  AMOUNT, FEE_PAYER, NOW, PAY_TO, PAYER, body, deps, keyed, requirements, typedData, world, type World,
} from './helpers.js';

const TX = '0xabc';
const PAYER_HEX = hex(BigInt(PAYER));

interface Rig { d: SettleDeps; w: World; submits: number; clock: { now: bigint } }
function rig(o: Partial<World> = {}, submit?: () => Promise<string>): Rig {
  const w = world(o);
  const clock = { now: NOW };
  const r: Rig = { w, submits: 0, clock, d: undefined as any };
  r.d = {
    ...deps(w, { now: () => clock.now }),
    submit: async () => { r.submits++; return submit ? submit() : TX; },
    cache: new SettleCache(),
    waitMs: 10,
  };
  return r;
}
const rpcRejection = () => new RpcError({ code: 41, message: 'rejected' } as any, 'starknet_addInvokeTransaction', {});

describe('/settle', () => {
  it('settles a valid payment: broadcast once, success with transaction, network and payer', async () => {
    const r = rig();
    const out = await settlePayment(r.d, body());
    assert.deepEqual(out, { success: true, transaction: TX, network: 'starknet:SN_SEPOLIA', payer: PAYER_HEX });
    assert.equal(r.submits, 1);
    assert.deepEqual(r.w.receiptWaits, [TX]);
  });

  it('re-runs every verification and broadcasts nothing when one fails', async () => {
    for (const [o, reason] of [
      [{ signature: 'invalid' }, 'invalid_exact_starknet_payload_signature'],
      [{ nonceFree: false }, 'nonce_already_used'],
      [{ balance: 0n }, 'insufficient_funds'],
      [{ events: 'reverted' }, 'simulation_failed'],
    ] as const) {
      const r = rig(o as Partial<World>);
      const out = await settlePayment(r.d, body());
      assert.equal(out.success, false);
      assert.equal(out.errorReason, reason);
      assert.equal(out.transaction, '');
      assert.equal(r.submits, 0, reason);
    }
  });

  it('does not report payer before the signature was verified', async () => {
    const out = await settlePayment(rig({ signature: 'invalid' }).d, body());
    assert.equal('payer' in out, false);
  });

  it('refuses a payload whose remaining window is below minSettleMargin', async () => {
    const r = rig();
    r.clock.now = NOW + 280n;                       // 20 s left of the 300 s window
    const out = await settlePayment(r.d, body());
    assert.equal(out.errorReason, 'outside_execution_expired');
    assert.equal(r.submits, 0);
  });

  it('does not re-apply the freshness bound: a payload signed a while ago still settles', async () => {
    const r = rig();
    r.clock.now = NOW + 100n;                       // 200 s left: well below now + maxTimeout - skew
    assert.equal((await settlePayment(r.d, body())).success, true);
  });

  it('answers a transport failure during re-verification with a generic code, and frees the key', async () => {
    const r = rig({ events: 'unavailable' });
    const out = await settlePayment(r.d, body());
    assert.equal(out.errorReason, 'unexpected_settle_error');
    assert.equal(r.submits, 0);
    r.w.events = [keyed(PAYER, PAY_TO, AMOUNT)];
    assert.equal((await settlePayment(r.d, body())).success, true);
  });

  describe('outcome', () => {
    it('reports a reverted transaction as failure with its hash, and allows the retry', async () => {
      const r = rig({ receipt: { executionStatus: 'REVERTED', events: [] } });
      const out = await settlePayment(r.d, body());
      assert.equal(out.success, false);
      assert.equal(out.errorReason, 'invalid_transaction_state');
      assert.equal(out.transaction, TX);
      r.w.receipt = { executionStatus: 'SUCCEEDED', events: [keyed(PAYER, PAY_TO, AMOUNT)] };
      assert.equal((await settlePayment(r.d, body())).success, true);
      assert.equal(r.submits, 2, 'a revert rolls the nonce back: the same payment may be broadcast again');
    });

    it('reports SUCCEEDED without the expected transfer as failure', async () => {
      for (const events of [
        [], [keyed(PAYER, PAY_TO, AMOUNT + 1n)], [keyed(PAYER, '0x99', AMOUNT)],
        [keyed(PAYER, PAY_TO, AMOUNT), keyed(PAYER, PAY_TO, AMOUNT)],
      ]) {
        const out = await settlePayment(rig({ receipt: { executionStatus: 'SUCCEEDED', events } }).d, body());
        assert.equal(out.success, false);
        assert.equal(out.errorReason, 'invalid_transaction_state');
        assert.equal(out.transaction, TX);
      }
    });

    it("ignores the executor's fee transfer in a real receipt", async () => {
      const events = [keyed(PAYER, PAY_TO, AMOUNT), keyed(FEE_PAYER, '0x77', 5n)];
      assert.equal((await settlePayment(rig({ receipt: { executionStatus: 'SUCCEEDED', events } }).d, body())).success, true);
    });
  });

  describe('settlement_pending', () => {
    it('is non-terminal, carries the hash, and the retry waits on it without broadcasting again', async () => {
      const r = rig({ receipt: 'unresolved' });
      const first = await settlePayment(r.d, body());
      assert.deepEqual(first, { success: false, transaction: TX, network: 'starknet:SN_SEPOLIA', payer: PAYER_HEX, errorReason: 'settlement_pending' });

      r.w.receipt = { executionStatus: 'SUCCEEDED', events: [keyed(PAYER, PAY_TO, AMOUNT)] };
      r.w.signature = 'invalid';                       // the retry does not verify again
      r.clock.now = NOW + 290n;                        // and is not refused for expiry
      const retry = await settlePayment(r.d, body());
      assert.equal(retry.success, true);
      assert.equal(retry.transaction, TX);
      assert.equal(r.submits, 1, 'never re-broadcast while the outcome was unresolved');
    });

    it('stays pending while the outcome is still unresolved on a retry', async () => {
      const r = rig({ receipt: 'unresolved' });
      await settlePayment(r.d, body());
      const retry = await settlePayment(r.d, body());
      assert.equal(retry.errorReason, 'settlement_pending');
      assert.equal(retry.transaction, TX);
      assert.equal(r.submits, 1);
    });

    it('a reverted outcome found on the retry frees the authorization', async () => {
      const r = rig({ receipt: 'unresolved' });
      await settlePayment(r.d, body());
      r.w.receipt = { executionStatus: 'REVERTED', events: [] };
      assert.equal((await settlePayment(r.d, body())).errorReason, 'invalid_transaction_state');
      r.w.receipt = { executionStatus: 'SUCCEEDED', events: [keyed(PAYER, PAY_TO, AMOUNT)] };
      assert.equal((await settlePayment(r.d, body())).success, true);
      assert.equal(r.submits, 2);
    });

    it('any other payload sharing the (from, Nonce) is a duplicate', async () => {
      const r = rig({ receipt: 'unresolved' });
      await settlePayment(r.d, body());
      const other = body(typedData({ before: Number(NOW) + 301 }));   // same nonce, other message
      const out = await settlePayment(r.d, other);
      assert.equal(out.errorReason, 'duplicate_settlement');
      assert.equal(out.transaction, '');
      assert.equal(r.submits, 1);
    });
  });

  describe('duplicates and broadcast failures', () => {
    it('refuses a repeat after success', async () => {
      const r = rig();
      assert.equal((await settlePayment(r.d, body())).success, true);
      const again = await settlePayment(r.d, body());
      assert.equal(again.success, false);
      assert.equal(again.errorReason, 'duplicate_settlement');
      assert.equal(r.submits, 1);
    });

    it('lets a concurrent twin through only once', async () => {
      const r = rig();
      const [a, b] = await Promise.all([settlePayment(r.d, body()), settlePayment(r.d, body())]);
      assert.deepEqual([a.success, b.success].sort(), [false, true]);
      assert.equal([a, b].find((x) => !x.success)!.errorReason, 'duplicate_settlement');
      assert.equal(r.submits, 1);
    });

    it('a rejection by the node frees the key (nothing was broadcast)', async () => {
      let n = 0;
      const r = rig({}, async () => { if (n++ === 0) throw rpcRejection(); return TX; });
      const first = await settlePayment(r.d, body());
      assert.equal(first.errorReason, 'unexpected_settle_error');
      assert.equal(first.transaction, '');
      assert.equal((await settlePayment(r.d, body())).success, true);
      assert.equal(r.submits, 2);
    });

    it('a broadcast that times out keeps the key and is never re-broadcast', async () => {
      const r = rig({}, async () => { throw new Error('ETIMEDOUT 10.0.0.1:9545'); });
      const first = await settlePayment(r.d, body());
      assert.equal(first.errorReason, 'unexpected_settle_error');
      assert.equal(first.transaction, '');
      assert.equal(JSON.stringify(first).includes('ETIMEDOUT'), false, 'no raw error text on the wire');
      assert.equal((await settlePayment(r.d, body())).errorReason, 'duplicate_settlement');
      assert.equal(r.submits, 1);
    });

    it('evicts entries once Execute Before + skewMargin has passed', async () => {
      const r = rig();
      assert.equal((await settlePayment(r.d, body())).success, true);
      r.clock.now = NOW + 300n + 61n;
      // the authorization can no longer execute; the key is gone, and re-verification refuses it as expired
      assert.equal((await settlePayment(r.d, body())).errorReason, 'outside_execution_expired');
    });
  });
});
