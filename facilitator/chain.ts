/**
 * The facilitator's view of Starknet, narrowed to what verification needs. Every read is made at
 * `latest` (an accepted block): pre-confirmed state never feeds an accept decision.
 *
 * Each method either answers, or throws: a transport-level failure (timeout, connection, node fault,
 * unreadable trace) is an absent answer, never a verdict. Callers turn it into `unexpected_verify_error`.
 */
import { Account, RpcError, RpcProvider, TransactionType, outsideExecution } from 'starknet';
import type { ChainEvent } from './transfers.js';
import { hex, type OutsideExecutionMessage } from './scheme.js';

export class Unavailable extends Error {}

export interface Receipt {
  executionStatus: string;
  events: ChainEvent[];
}

export type CallResult = { ok: true; result: string[] } | { ok: false };

export interface Chain {
  chainId(): Promise<string>;
  /** false when the node reports a structured contract-not-found. */
  isDeployed(address: bigint): Promise<boolean>;
  /** `ok: false` for a structured contract-level answer (revert, missing entry point). */
  call(address: bigint, entrypoint: string, calldata: string[]): Promise<CallResult>;
  /**
   * The receipt of `hash` once it is final enough to be an outcome: finality ACCEPTED_ON_L2 or
   * ACCEPTED_ON_L1 and a block number. A pre-confirmed or unknown transaction is not an outcome yet.
   * Throws `Unavailable` when no outcome was established within `timeoutMs` or the node failed.
   */
  waitForReceipt(hash: string, timeoutMs: number): Promise<Receipt>;
  /** Events of the simulated settlement, or 'reverted' when the node ran it and it reverted. */
  simulateSettlement(from: bigint, message: OutsideExecutionMessage, signature: string[]): Promise<ChainEvent[] | 'reverted'>;
}

const isRpc = (e: unknown, ...types: string[]) =>
  e instanceof RpcError && types.some((t) => (e as any).isType(t));

interface Frame {
  contract_address?: string;
  events?: { keys: string[]; data: string[] }[];
  calls?: Frame[];
  revert_reason?: string;
}

/** Every event of the call tree, attributed to the contract of its enclosing frame. */
export function eventsOf(frame: Frame): ChainEvent[] {
  if (!frame || typeof frame.contract_address !== 'string' || !Array.isArray(frame.events) || !Array.isArray(frame.calls)) {
    throw new Unavailable('unreadable trace');
  }
  const own = frame.events.map((e) => ({ from_address: frame.contract_address!, keys: e.keys, data: e.data }));
  return own.concat(...frame.calls.map(eventsOf));
}

/** The SNIP-9 v2 outside transaction `execute_from_outside_v2` is built from. */
export function toOutsideTransaction(from: bigint, m: OutsideExecutionMessage, signature: string[]) {
  return {
    outsideExecution: {
      caller: hex(m.caller), nonce: hex(m.nonce),
      execute_after: hex(m.executeAfter), execute_before: hex(m.executeBefore),
      calls: m.calls.map((c) => ({ to: hex(c.to), selector: hex(c.selector), calldata: c.calldata.map(hex) })),
    },
    signature, signerAddress: hex(from), version: '2' as const,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function rpcChain(provider: RpcProvider, executor: Account, pollMs = 1500): Chain {
  return {
    chainId: () => provider.getChainId() as Promise<string>,

    async isDeployed(address) {
      try {
        await provider.getClassHashAt(hex(address), 'latest');
        return true;
      } catch (e) {
        if (isRpc(e, 'CONTRACT_NOT_FOUND')) return false;
        throw e;
      }
    },

    async call(address, entrypoint, calldata) {
      try {
        const result = await provider.callContract({ contractAddress: hex(address), entrypoint, calldata }, 'latest');
        return { ok: true, result };
      } catch (e) {
        if (isRpc(e, 'CONTRACT_ERROR', 'ENTRYPOINT_NOT_FOUND')) return { ok: false };
        throw e;
      }
    },

    async waitForReceipt(hash, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        try {
          const r: any = await provider.getTransactionReceipt(hash);
          const final = r?.finality_status === 'ACCEPTED_ON_L2' || r?.finality_status === 'ACCEPTED_ON_L1';
          if (final && r.block_number !== undefined && r.block_number !== null) {
            if (typeof r.execution_status !== 'string' || !Array.isArray(r.events)) throw new Unavailable('unreadable receipt');
            return {
              executionStatus: r.execution_status,
              events: r.events.map((e: any) => ({ from_address: e.from_address, keys: e.keys, data: e.data })),
            };
          }
        } catch (e) {
          if (e instanceof Unavailable) throw e;
          if (!isRpc(e, 'TXN_HASH_NOT_FOUND')) throw new Unavailable(`receipt: ${e instanceof Error ? e.message : e}`);
        }
        if (Date.now() + pollMs > deadline) throw new Unavailable('no outcome before the deadline');
        await sleep(pollMs);
      }
    },

    async simulateSettlement(from, m, signature) {
      const [call] = outsideExecution.buildExecuteFromOutsideCall(toOutsideTransaction(from, m, signature));
      let res;
      try {
        // skipFeeCharge is the starknet.js default (so the trace carries no fee Transfer, as rule 8 assumes).
        res = await executor.simulateTransaction(
          [{ type: TransactionType.INVOKE, payload: [call] }],
          { skipValidate: true, blockIdentifier: 'latest' },
        );
      } catch (e) {
        if (isRpc(e, 'TRANSACTION_EXECUTION_ERROR')) return 'reverted';
        throw e;
      }
      const trace: any = res?.simulated_transactions?.[0]?.transaction_trace;
      const exec = trace?.execute_invocation ?? trace?.invoke_tx_trace?.execute_invocation;
      if (!exec) throw new Unavailable('unreadable trace');
      if (typeof exec.revert_reason === 'string') return 'reverted';
      return eventsOf(exec);
    },
  };
}
