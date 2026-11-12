/** Unit tests of the pure `exact` scheme rules. No network, no keys. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { outsideExecution, typedData as snTypedData, constants } from 'starknet';
import * as S from '../scheme.js';

const ASSET = '0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343';
const PAY_TO = '0x02dd1b492765c064eac4039e3841aa5f382773b598097a40073bd8b48170ab57';
const FEE_PAYER = '0x05f2e02acd59f37f1e19da7ea1db6bf31d49e6e5ba66a7f1c2f0e2ba1be36f81';
const PAYER = '0x03f16efeb2ae57f7d8befb03af08a3a370562dde15149c3506ac2038ffa9be24';
const NOW = 1_800_000_000n;

const ctx: S.RequirementsContext = {
  networks: S.NETWORKS,
  feePayer: () => BigInt(FEE_PAYER),
};
const requirements = (o: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  scheme: 'exact', network: 'starknet:SN_SEPOLIA', amount: '10000', asset: ASSET, payTo: PAY_TO,
  maxTimeoutSeconds: 300, extra: { feePayer: FEE_PAYER, ...extra }, ...o,
});
const code = (fn: () => unknown) => {
  try { fn(); } catch (e: any) { return e instanceof S.SchemeError ? e.code : `OTHER:${e.message}`; }
  return 'none';
};

/** Typed data built by starknet.js itself, the oracle for our own reconstruction. */
function oracleTypedData(over: { caller?: string; after?: number; before?: number; amount?: bigint; to?: string } = {}) {
  return outsideExecution.getTypedData(
    constants.StarknetChainId.SN_SEPOLIA,
    {
      caller: over.caller ?? FEE_PAYER, execute_after: over.after ?? 1,
      execute_before: over.before ?? Number(NOW) + 300,
    },
    '0x71b7b56b17c8e0f4dcd0d9427c30d0a8bfa3c53f4d95a3b26f6cf14f3d0f8e2',
    [{
      contractAddress: over.to ?? ASSET, entrypoint: 'transfer',
      calldata: [PAY_TO, (over.amount ?? 10000n).toString(), '0'],
    }],
    '2',
  ) as any;
}
// getTypedData returns starknet.js's shared type tables: clone before any mutation.
const fresh = (o: Parameters<typeof oracleTypedData>[0] = {}) => structuredClone(oracleTypedData(o));
const req = () => S.validateRequirements(requirements(), ctx);

describe('requirements (rule 1)', () => {
  it('accepts well-formed requirements', () => assert.equal(code(req), 'none'));
  it('refuses the pre-scheme network id', () =>
    assert.equal(code(() => S.validateRequirements(requirements({ network: 'starknet:sepolia' }), ctx)), 'invalid_network'));
  it('refuses a non-decimal amount', () => {
    for (const amount of ['0x10', '-1', '1.5', ' 5', '', 10000])
      assert.equal(code(() => S.validateRequirements(requirements({ amount }), ctx)), 'invalid_payment_requirements', String(amount));
  });
  it('refuses a missing feePayer instead of skipping the caller binding', () =>
    assert.equal(code(() => S.validateRequirements(requirements({ extra: {} }), ctx)), 'invalid_payment_requirements'));
  it('refuses zero, ANY_CALLER, and payer as feePayer', () => {
    for (const feePayer of ['0x0', '0x414e595f43414c4c4552'])
      assert.equal(code(() => S.validateRequirements(requirements({}, { feePayer }), ctx)), 'invalid_payment_requirements');
    assert.equal(code(() => S.validateRequirements(
      requirements({}, { feePayer: PAYER }), { ...ctx, feePayer: () => BigInt(PAYER) }, BigInt(PAYER))), 'invalid_payment_requirements');
  });
  it('refuses a feePayer the facilitator does not announce', () =>
    assert.equal(code(() => S.validateRequirements(requirements({}, { feePayer: '0x1234' }), ctx)), 'invalid_payment_requirements'));
  it('refuses a window at or below minSettleMargin, or a non-integer', () => {
    for (const maxTimeoutSeconds of [30, 0, -5, 300.5, '300', undefined])
      assert.equal(code(() => S.validateRequirements(requirements({ maxTimeoutSeconds }), ctx)), 'invalid_payment_requirements', String(maxTimeoutSeconds));
  });
  it('checks the reserved extra keys by value', () => {
    assert.equal(code(() => S.validateRequirements(requirements({}, { assetTransferMethod: 'permit' }), ctx)), 'invalid_payment_requirements');
    assert.equal(code(() => S.validateRequirements(requirements({}, { paymentFlow: 'upfront' }), ctx)), 'invalid_payment_requirements');
    assert.equal(code(() => S.validateRequirements(requirements({}, { assetTransferMethod: 'default', paymentFlow: 'authorization' }), ctx)), 'none');
  });
  it('compares addresses numerically, ignoring leading zeros', () => {
    const r = S.validateRequirements(requirements({ payTo: PAY_TO.replace('0x02dd', '0x2dd') }), ctx);
    assert.equal(code(() => S.checkAccepted(requirements(), r)), 'none');
  });
});

describe('accepted must equal the requirements', () => {
  for (const [name, patch, expected] of [
    ['amount', { amount: '9999' }, 'invalid_payload'],
    ['scheme', { scheme: 'upto' }, 'invalid_scheme'],
    ['network', { network: 'starknet:SN_MAIN' }, 'invalid_network'],
    ['payTo', { payTo: '0x1' }, 'invalid_payload'],
    ['asset', { asset: '0x1' }, 'invalid_payload'],
    ['maxTimeoutSeconds', { maxTimeoutSeconds: 3000 }, 'invalid_payload'],
  ] as const) {
    it(`rejects a changed ${name}`, () =>
      assert.equal(code(() => S.checkAccepted({ ...requirements(), ...patch }, req())), expected));
  }
  it('rejects a changed feePayer', () =>
    assert.equal(code(() => S.checkAccepted(requirements({}, { feePayer: '0x1' }), req())), 'invalid_payload'));
});

describe('typed data canonicalization (rule 2)', () => {
  it('hashes exactly like starknet.js does for the same message', () => {
    const td = oracleTypedData();
    const c = S.canonicalize(td, 'starknet:SN_SEPOLIA');
    assert.equal(S.messageHash(c, BigInt(PAYER)), snTypedData.getMessageHash(td, PAYER));
  });
  it('accepts the chain id as hex, decimal or short string, all the same felt', () => {
    const base = S.messageHash(S.canonicalize(oracleTypedData(), 'starknet:SN_SEPOLIA'), BigInt(PAYER));
    for (const chainId of ['0x534e5f5345504f4c4941', BigInt('0x534e5f5345504f4c4941').toString(), 'SN_SEPOLIA']) {
      const td = fresh(); td.domain.chainId = chainId;
      assert.equal(S.messageHash(S.canonicalize(td, 'starknet:SN_SEPOLIA'), BigInt(PAYER)), base, chainId);
    }
  });
  it('refuses a chain id that is not the one of the network', () => {
    const td = fresh(); td.domain.chainId = 'SN_MAIN';
    assert.equal(code(() => S.canonicalize(td, 'starknet:SN_SEPOLIA')), 'invalid_payload');
  });
  it('refuses unknown or missing keys in domain and message', () => {
    for (const mutate of [
      (t: any) => { t.domain.extra = 1; }, (t: any) => { delete t.domain.revision; },
      (t: any) => { t.message.Extra = 1; }, (t: any) => { delete t.message.Nonce; },
      (t: any) => { t.message.Calls[0].Extra = 1; },
    ]) {
      const td = fresh(); mutate(td);
      assert.equal(code(() => S.canonicalize(td, 'starknet:SN_SEPOLIA')), 'invalid_payload');
    }
  });
  it('refuses a v1 outside execution (revision 0)', () => {
    const td = fresh(); td.domain.revision = '0'; td.domain.version = '1';
    assert.equal(code(() => S.canonicalize(td, 'starknet:SN_SEPOLIA')), 'invalid_payload');
  });
  it('ignores the declared types: only the parsed values are hashed', () => {
    const td = fresh();
    td.types.OutsideExecution = [{ name: 'Caller', type: 'felt' }];
    assert.equal(code(() => S.canonicalize(td, 'starknet:SN_SEPOLIA')), 'none');
    assert.equal(S.messageHash(S.canonicalize(td, 'starknet:SN_SEPOLIA'), BigInt(PAYER)),
      snTypedData.getMessageHash(oracleTypedData(), PAYER));
  });
  it('refuses an out-of-range or unparsable value', () => {
    for (const v of ['0x' + 'f'.repeat(70), '12abc', -1, 1.5, null]) {
      const td = fresh(); td.message.Nonce = v;
      assert.equal(code(() => S.canonicalize(td, 'starknet:SN_SEPOLIA')), 'invalid_payload', String(v));
    }
    const td = fresh(); td.message['Execute Before'] = (2n ** 128n).toString();
    assert.equal(code(() => S.canonicalize(td, 'starknet:SN_SEPOLIA')), 'invalid_payload');
  });
});

describe('caller binding (rule 4)', () => {
  it('requires Caller to equal feePayer', () => {
    const ok = S.canonicalize(oracleTypedData(), 'starknet:SN_SEPOLIA').message;
    assert.equal(code(() => S.checkCaller(ok, req())), 'none');
    for (const caller of ['0x414e595f43414c4c4552', '0x1']) {
      const m = S.canonicalize(oracleTypedData({ caller }), 'starknet:SN_SEPOLIA').message;
      assert.equal(code(() => S.checkCaller(m, req())), 'invalid_exact_starknet_payload_caller', caller);
    }
  });
});

describe('time window (rule 5)', () => {
  const msg = (after: number, before: number) =>
    S.canonicalize(oracleTypedData({ after, before }), 'starknet:SN_SEPOLIA').message;
  const n = Number(NOW);
  it('accepts the signing rule: after in the past, before = now + maxTimeoutSeconds', () =>
    assert.equal(code(() => S.checkWindow(msg(1, n + 300), req(), NOW, 'verify')), 'none'));
  it('tolerates skewMargin around now + maxTimeoutSeconds, not more', () => {
    assert.equal(code(() => S.checkWindow(msg(1, n + 300 - 60), req(), NOW, 'verify')), 'none');
    assert.equal(code(() => S.checkWindow(msg(1, n + 300 - 61), req(), NOW, 'verify')), 'outside_execution_expired');
    assert.equal(code(() => S.checkWindow(msg(1, n + 300 + 60), req(), NOW, 'verify')), 'none');
    assert.equal(code(() => S.checkWindow(msg(1, n + 300 + 61), req(), NOW, 'verify')), 'outside_execution_window_exceeds_max_timeout');
  });
  it('rejects an Execute After that is not well in the past', () =>
    assert.equal(code(() => S.checkWindow(msg(n - 10, n + 300), req(), NOW, 'verify')), 'invalid_payload'));
  it('applies the minSettleMargin floor at both phases', () => {
    for (const phase of ['verify', 'settle'] as const)
      assert.equal(code(() => S.checkWindow(msg(1, n + 30), req(), NOW, phase)), 'outside_execution_expired');
    assert.equal(code(() => S.checkWindow(msg(1, n + 31), req(), NOW, 'settle')), 'none');
  });
  it('does not re-apply the freshness lower bound at settle', () =>
    assert.equal(code(() => S.checkWindow(msg(1, n + 100), req(), NOW, 'settle')), 'none'));
  it('still enforces the upper bound at settle', () =>
    assert.equal(code(() => S.checkWindow(msg(1, n + 400), req(), NOW, 'settle')), 'outside_execution_window_exceeds_max_timeout'));
});

describe('payment intent (rule 7)', () => {
  const m = (o: Parameters<typeof oracleTypedData>[0] = {}) =>
    S.canonicalize(oracleTypedData(o), 'starknet:SN_SEPOLIA').message;
  it('accepts exactly the required transfer', () => assert.equal(code(() => S.checkIntent(m(), req())), 'none'));
  it('rejects overpayment and underpayment', () => {
    for (const amount of [9999n, 10001n])
      assert.equal(code(() => S.checkIntent(m({ amount }), req())), 'invalid_exact_starknet_payload_amount_mismatch');
  });
  it('rejects a high word that smuggles the amount', () => {
    const msg = m(); msg.calls[0].calldata[2] = 1n;
    assert.equal(code(() => S.checkIntent(msg, req())), 'invalid_exact_starknet_payload_amount_mismatch');
  });
  it('rejects a limb that is not a u128', () => {
    const msg = m(); msg.calls[0].calldata[1] = 2n ** 128n;
    assert.equal(code(() => S.checkIntent(msg, req())), 'invalid_payload');
  });
  it('rejects a wrong asset and a wrong recipient', () => {
    assert.equal(code(() => S.checkIntent(m({ to: '0x1' }), req())), 'invalid_exact_starknet_payload_asset_mismatch');
    const msg = m(); msg.calls[0].calldata[0] = 1n;
    assert.equal(code(() => S.checkIntent(msg, req())), 'invalid_exact_starknet_payload_recipient_mismatch');
  });
  it('rejects a second call, a wrong selector, and extra calldata', () => {
    const two = m(); two.calls.push(two.calls[0]);
    assert.equal(code(() => S.checkIntent(two, req())), 'invalid_payload');
    const sel = m(); sel.calls[0].selector = 1n;
    assert.equal(code(() => S.checkIntent(sel, req())), 'invalid_payload');
    const cd = m(); cd.calls[0].calldata.push(0n);
    assert.equal(code(() => S.checkIntent(cd, req())), 'invalid_payload');
  });
});

describe('payment payload envelope', () => {
  const ok = { x402Version: 2, accepted: requirements(), payload: { from: PAYER, outsideExecution: { typedData: {}, signature: ['0x1', '0x2'] } } };
  it('parses the registered shape', () => assert.equal(S.parsePaymentPayload(ok).payload.from, BigInt(PAYER)));
  it('refuses another version, the pre-scheme shape, and a bad signature array', () => {
    assert.equal(code(() => S.parsePaymentPayload({ ...ok, x402Version: 1 })), 'invalid_x402_version');
    assert.equal(code(() => S.parsePaymentPayload({ x402Version: 2, payload: { authorization: {}, outsideTransaction: {} } })), 'invalid_payload');
    for (const signature of [[], 'x', Array(33).fill('0x1')])
      assert.equal(code(() => S.parsePaymentPayload({ ...ok, payload: { from: PAYER, outsideExecution: { typedData: {}, signature } } })), 'invalid_payload');
  });
});
