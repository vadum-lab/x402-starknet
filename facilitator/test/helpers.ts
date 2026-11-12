/** Shared fixtures for the verify / settle tests: a fake Chain and a valid payment. */
import { outsideExecution, constants } from 'starknet';
import { Unavailable, type Chain, type Receipt } from '../chain.js';
import type { VerifyDeps } from '../verify.js';
import { hex, TRANSFER_EVENT_KEY } from '../scheme.js';
import type { ChainEvent } from '../transfers.js';

export const ASSET = '0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343';
export const PAY_TO = '0x02dd1b492765c064eac4039e3841aa5f382773b598097a40073bd8b48170ab57';
export const FEE_PAYER = '0x05f2e02acd59f37f1e19da7ea1db6bf31d49e6e5ba66a7f1c2f0e2ba1be36f81';
export const PAYER = '0x03f16efeb2ae57f7d8befb03af08a3a370562dde15149c3506ac2038ffa9be24';
export const NOW = 1_800_000_000n;
export const AMOUNT = 10000n;
export const KEY = hex(TRANSFER_EVENT_KEY);
export const u = (n: bigint) => [hex(n & (2n ** 128n - 1n)), hex(n >> 128n)];

export const keyed = (from: string, to: string, amount: bigint, asset = ASSET): ChainEvent =>
  ({ from_address: asset, keys: [KEY, from, to], data: u(amount) });
export const legacy = (from: string, to: string, amount: bigint): ChainEvent =>
  ({ from_address: ASSET, keys: [KEY], data: [from, to, ...u(amount)] });

export interface World {
  deployed: boolean; signature: 'valid' | 'invalid' | 'throw'; nonceFree: boolean | 'throw';
  balance: bigint; getters: 'balance_of' | 'balanceOf' | 'none'; chainId: string;
  events: ChainEvent[] | 'reverted' | 'unavailable';
  calls: string[];
  /** What waitForReceipt yields: a receipt, or 'unresolved' (no outcome before the deadline). */
  receipt: Receipt | 'unresolved';
  receiptWaits: string[];
}
export const world = (o: Partial<World> = {}): World => ({
  deployed: true, signature: 'valid', nonceFree: true, balance: 10n ** 21n, getters: 'balance_of',
  chainId: constants.StarknetChainId.SN_SEPOLIA, events: [keyed(PAYER, PAY_TO, AMOUNT)], calls: [],
  receipt: { executionStatus: 'SUCCEEDED', events: [keyed(PAYER, PAY_TO, AMOUNT)] }, receiptWaits: [], ...o,
});

export function fakeChain(w: World): Chain {
  return {
    chainId: async () => w.chainId,
    isDeployed: async () => w.deployed,
    async call(_addr, entrypoint) {
      w.calls.push(entrypoint);
      if (entrypoint === 'is_valid_signature') {
        if (w.signature === 'throw') throw new Unavailable('rpc down');
        return w.signature === 'valid' ? { ok: true, result: ['0x56414c4944'] } : { ok: false };
      }
      if (entrypoint === 'is_valid_outside_execution_nonce') {
        if (w.nonceFree === 'throw') throw new Unavailable('rpc down');
        return w.nonceFree ? { ok: true, result: ['0x1'] } : { ok: true, result: ['0x0'] };
      }
      if (w.getters === 'none' || w.getters !== entrypoint) return { ok: false };
      return { ok: true, result: u(w.balance) };
    },
    async waitForReceipt(hash) {
      w.receiptWaits.push(hash);
      if (w.receipt === 'unresolved') throw new Unavailable('no outcome before the deadline');
      return w.receipt;
    },
    async simulateSettlement() {
      if (w.events === 'unavailable') throw new Unavailable('unreadable trace');
      return w.events;
    },
  };
}

export const deps = (w: World, o: Partial<VerifyDeps> = {}): VerifyDeps => ({
  chain: fakeChain(w), network: 'starknet:SN_SEPOLIA', feePayer: BigInt(FEE_PAYER), now: () => NOW, ...o,
});
export const requirements = (o: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  scheme: 'exact', network: 'starknet:SN_SEPOLIA', amount: AMOUNT.toString(), asset: ASSET, payTo: PAY_TO,
  maxTimeoutSeconds: 300, extra: { feePayer: FEE_PAYER, ...extra }, ...o,
});
export function typedData(over: { caller?: string; amount?: bigint; before?: number } = {}) {
  return structuredClone(outsideExecution.getTypedData(
    constants.StarknetChainId.SN_SEPOLIA,
    { caller: over.caller ?? FEE_PAYER, execute_after: 1, execute_before: over.before ?? Number(NOW) + 300 },
    '0x71b7', [{ contractAddress: ASSET, entrypoint: 'transfer', calldata: [PAY_TO, (over.amount ?? AMOUNT).toString(), '0'] }],
    '2',
  ));
}
export const body = (td: unknown = typedData(), reqs: unknown = requirements(), from = PAYER, accepted: unknown = reqs) => ({
  x402Version: 2,
  paymentPayload: { x402Version: 2, accepted, payload: { from, outsideExecution: { typedData: td, signature: ['0x1', '0x2'] } } },
  paymentRequirements: reqs,
});

