/**
 * `/settle` of the `exact` scheme on Starknet (settlement steps 1 to 7 and the duplicate cache).
 *
 *  1. re-run every verification rule, simulation included (a prior /verify is never trusted);
 *  2. submit `execute_from_outside_v2` from the executor, which pays the gas;
 *  3. wait for ACCEPTED_ON_L2 / ACCEPTED_ON_L1 with a block number;
 *  4. success only if SUCCEEDED and the receipt shows exactly the expected payer Transfer.
 *
 * An unresolved outcome is `settlement_pending` with the hash, and is never re-broadcast: the retry of
 * the same payload waits on that hash. Any other repeat of `(from, Nonce)` is `duplicate_settlement`.
 * The cache is in-process: a restart loses it (accepted deviation, ADR-0022 item 7).
 */
import { RpcError } from 'starknet';
import {
  SKEW_MARGIN, SchemeError, checkWindow, hex, parseAddress, type ErrorCode, type Network, type OutsideExecutionMessage,
} from './scheme.js';
import { Unavailable } from './chain.js';
import { chainChecks, precheck, type VerifyDeps } from './verify.js';
import { payerTransferIsExact } from './transfers.js';

export interface Entry {
  digest: string;
  state: 'starting' | 'pending' | 'done';
  hash?: string;
  payer?: string;
  /** Unix seconds after which the authorization can no longer execute, even with timestamp lag. */
  expires: bigint;
}

/** Short-lived cache keyed by `(payload.from, Nonce)`. */
export class SettleCache {
  private map = new Map<string, Entry>();
  get(key: string, now: bigint): Entry | undefined {
    for (const [k, e] of this.map) if (e.expires < now) this.map.delete(k);
    return this.map.get(key);
  }
  set(key: string, e: Entry) { this.map.set(key, e); }
  delete(key: string) { this.map.delete(key); }
}

export interface SettleDeps extends VerifyDeps {
  /** Submits the outside execution and returns the transaction hash. Throws if nothing was accepted. */
  submit(from: bigint, message: OutsideExecutionMessage, signature: string[]): Promise<string>;
  cache: SettleCache;
  /** How long /settle waits for an outcome before answering settlement_pending. */
  waitMs: number;
}

export interface SettleResponse {
  success: boolean;
  transaction: string;
  network: Network;
  payer?: string;
  errorReason?: ErrorCode;
}

export async function settlePayment(d: SettleDeps, body: unknown): Promise<SettleResponse> {
  let payer: string | undefined;
  let transaction = '';
  let key: string | undefined;
  let p!: ReturnType<typeof precheck>;
  let broadcastAttempted = false;

  const out = (errorReason?: ErrorCode): SettleResponse => ({
    success: errorReason === undefined, transaction, network: d.network,
    ...(payer ? { payer } : {}), ...(errorReason ? { errorReason } : {}),
  });

  try {
    // Everything but the time window first: the retry of a pending payment must not be refused for expiry.
    p = precheck(d, body, 'none');
    const { from, canonical } = { from: p.payload.from, canonical: p.canonical };
    key = `${hex(from)}:${hex(canonical.message.nonce)}`;
    const digest = JSON.stringify([canonical.typedData, p.payload.signature]);
    const now = d.now();

    const entry = d.cache.get(key, now);
    if (entry) {
      if (entry.state === 'pending' && entry.hash && entry.digest === digest) {
        payer = entry.payer;
        transaction = entry.hash;
        return await outcome(entry);
      }
      key = undefined;                       // not ours: never evict the other request's entry
      throw new SchemeError('duplicate_settlement');
    }
    // Inserted before any await, so a concurrent twin of this request is a duplicate.
    const mine: Entry = { digest, state: 'starting', expires: canonical.message.executeBefore + SKEW_MARGIN };
    d.cache.set(key, mine);

    checkWindow(canonical.message, p.req, now, 'settle');
    await chainChecks(d, p, () => { payer = hex(from); });

    broadcastAttempted = true;
    let hash: string;
    try {
      hash = await d.submit(from, canonical.message, p.payload.signature);
    } catch (e) {
      d.log?.(`settle: broadcast failed: ${e instanceof Error ? e.message : String(e)}`);
      // The node answered with a rejection: nothing was broadcast, the authorization stays retryable.
      // Any other failure (timeout, connection) leaves the outcome unknown: the key stays, no re-broadcast.
      if (e instanceof RpcError) d.cache.delete(key);
      throw new SchemeError('unexpected_settle_error');
    }
    mine.hash = hash;
    mine.payer = payer;
    mine.state = 'pending';
    transaction = hash;
    d.log?.(`settle: broadcast ${hash}`);
    return await outcome(mine);
  } catch (e) {
    if (!(e instanceof SchemeError)) d.log?.(`settle: ${e instanceof Error ? e.message : String(e)}`);
    // Before the broadcast there is nothing to protect: free the key so a legitimate retry is not blocked.
    if (key && !broadcastAttempted) d.cache.delete(key);
    return out(e instanceof SchemeError ? e.code : 'unexpected_settle_error');
  }

  /** Steps 3 and 4 on a broadcast transaction. */
  async function outcome(entry: Entry): Promise<SettleResponse> {
    let receipt;
    try {
      receipt = await d.chain.waitForReceipt(entry.hash!, d.waitMs);
    } catch (e) {
      d.log?.(`settle: ${entry.hash} unresolved: ${e instanceof Error ? e.message : String(e)}`);
      entry.state = 'pending';
      return out('settlement_pending');
    }
    if (receipt.executionStatus === 'REVERTED') {
      d.cache.delete(key!);                  // the revert rolled the SNIP-9 nonce back: retryable
      return out('invalid_transaction_state');
    }
    entry.state = 'done';
    const ok = receipt.executionStatus === 'SUCCEEDED' &&
      payerTransferIsExact(receipt.events, parseAddress(p.req.asset), p.payload.from, parseAddress(p.req.payTo), BigInt(p.req.amount));
    return ok ? out() : out('invalid_transaction_state');
  }

}
