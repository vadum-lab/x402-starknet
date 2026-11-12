/**
 * Payer-scoped `Transfer` accounting, shared by the settlement simulation (rule 8) and the
 * settlement receipt (settlement step 4). Pure.
 *
 * A `Transfer` is an event emitted by the asset whose first key is sn_keccak("Transfer"), in either
 * standard layout: keyed (keys = [sel, from, to], data = [low, high]) or legacy unkeyed
 * (keys = [sel], data = [from, to, low, high]). An asset-emitted event with the Transfer key that
 * fits neither layout makes the whole check fail closed.
 */
import { TRANSFER_EVENT_KEY, parseFelt } from './scheme.js';

export interface ChainEvent {
  /** Emitting contract. In a trace this is the enclosing call frame's address. */
  from_address: string;
  keys: string[];
  data: string[];
}

interface Transfer { from: bigint; to: bigint; amount: bigint }

const U128 = 2n ** 128n;
const big = (v: string) => parseFelt(v);

/** Undefined when the event fits neither layout. */
function decode(e: ChainEvent): Transfer | undefined {
  try {
    let from: bigint, to: bigint, low: bigint, high: bigint;
    if (e.keys.length === 3 && e.data.length === 2) {
      [from, to] = [big(e.keys[1]), big(e.keys[2])];
      [low, high] = [big(e.data[0]), big(e.data[1])];
    } else if (e.keys.length === 1 && e.data.length === 4) {
      [from, to, low, high] = e.data.map(big);
    } else return undefined;
    if (low >= U128 || high >= U128) return undefined;
    return { from, to, amount: low + (high << 128n) };
  } catch {
    return undefined;
  }
}

/**
 * True only if `events` carry exactly one asset `Transfer` sent by `payer`, to `payTo`, for exactly
 * `amount`. Transfers by other senders (the executor's fee, for instance) do not count against it.
 */
export function payerTransferIsExact(
  events: ChainEvent[], asset: bigint, payer: bigint, payTo: bigint, amount: bigint,
): boolean {
  const mine: Transfer[] = [];
  try {
    for (const e of events) {
      if (parseFelt(e.from_address) !== asset) continue;
      if (e.keys.length === 0 || big(e.keys[0]) !== TRANSFER_EVENT_KEY) continue;
      const t = decode(e);
      if (!t) return false;
      if (t.from === payer) mine.push(t);
    }
  } catch {
    return false;                       // an event we cannot read is not proof of payment
  }
  return mine.length === 1 && mine[0].to === payTo && mine[0].amount === amount;
}
