/**
 * Pure rules of the x402 `exact` scheme on Starknet. No network, no RPC, no state.
 *
 * Conforms to x402-foundation/x402 `specs/schemes/exact/scheme_exact_starknet.md` at commit
 * d6d2c580142eec4ff96935ad834009454253d9a3 (blob 4d778150). Section numbers below are that
 * file's "Facilitator Verification Rules". Later upstream changes are not adopted automatically.
 *
 * Every check throws a `SchemeError` carrying one stable error code of the scheme.
 */
import { constants, hash, shortString, typedData as snTypedData } from 'starknet';

export const SCHEME = 'exact';
export const X402_VERSION = 2;
export const NETWORKS = ['starknet:SN_MAIN', 'starknet:SN_SEPOLIA'] as const;
export type Network = (typeof NETWORKS)[number];

/** CAIP-2 reference of a network: the string form of the chain id. */
export const CHAIN_ID: Record<Network, string> = {
  'starknet:SN_MAIN': constants.StarknetChainId.SN_MAIN,
  'starknet:SN_SEPOLIA': constants.StarknetChainId.SN_SEPOLIA,
};

/** Seconds. The scheme recommends skewMargin <= 60 and minSettleMargin >= 30. */
export const SKEW_MARGIN = 60n;
export const MIN_SETTLE_MARGIN = 30n;
export const MAX_SIGNATURE_FELTS = 32;

export const ANY_CALLER = BigInt(constants.OutsideExecutionCallerAny);
export const TRANSFER_SELECTOR = BigInt(hash.getSelectorFromName('transfer'));
export const TRANSFER_EVENT_KEY = BigInt(hash.getSelectorFromName('Transfer'));

const FELT_PRIME = 2n ** 251n + 17n * 2n ** 192n + 1n;
const ADDRESS_BOUND = 2n ** 251n;
const U128 = 2n ** 128n;
const U256 = 2n ** 256n;

/** Stable tokens: consumers switch on them, so no human text is ever appended. */
export type ErrorCode =
  | 'invalid_x402_version' | 'invalid_scheme' | 'invalid_network' | 'invalid_payload'
  | 'invalid_payment_requirements' | 'invalid_transaction_state'
  | 'insufficient_funds' | 'unexpected_verify_error' | 'unexpected_settle_error' | 'settlement_pending'
  | 'invalid_exact_starknet_payload_signature' | 'invalid_exact_starknet_payload_asset_mismatch'
  | 'invalid_exact_starknet_payload_recipient_mismatch' | 'invalid_exact_starknet_payload_amount_mismatch'
  | 'invalid_exact_starknet_payload_caller' | 'account_not_deployed'
  | 'outside_execution_expired' | 'outside_execution_window_exceeds_max_timeout'
  | 'nonce_already_used' | 'simulation_failed' | 'duplicate_settlement';

export class SchemeError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}
const fail = (code: ErrorCode): never => { throw new SchemeError(code); };

// ---------------------------------------------------------------------------------------------
// Parsing. Felts and addresses are compared as numbers, never as strings.
// ---------------------------------------------------------------------------------------------

/** A felt from a hex string, a base-10 string, or a safe integer. Anything else is refused. */
export function parseFelt(value: unknown, code: ErrorCode = 'invalid_payload'): bigint {
  let n: bigint;
  if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) n = BigInt(value);
  else return fail(code);
  return n >= 0n && n < FELT_PRIME ? n : fail(code);
}

export function parseAddress(value: unknown, code: ErrorCode = 'invalid_payload'): bigint {
  const n = parseFelt(value, code);
  return n < ADDRESS_BOUND ? n : fail(code);
}

function parseU128(value: unknown): bigint {
  const n = parseFelt(value);
  return n < U128 ? n : fail('invalid_payload');
}

/** A chain id as a hex felt, its decimal form, or the raw short string (`SN_MAIN`). */
function parseChainId(value: unknown): bigint {
  if (typeof value !== 'string') return fail('invalid_payload');
  if (/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) return BigInt(value);
  try { return BigInt(shortString.encodeShortString(value)); } catch { return fail('invalid_payload'); }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function exactKeys(obj: Record<string, unknown>, keys: string[]): void {
  const have = Object.keys(obj);
  if (have.length !== keys.length || !keys.every((k) => have.includes(k))) fail('invalid_payload');
}

export const hex = (n: bigint) => '0x' + n.toString(16);

// ---------------------------------------------------------------------------------------------
// Requirements (rule 1, server-supplied side)
// ---------------------------------------------------------------------------------------------

export interface Requirements {
  scheme: string;
  network: Network;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { feePayer: string; assetTransferMethod?: string; paymentFlow?: string; [k: string]: unknown };
}

export interface RequirementsContext {
  /** Networks this facilitator serves. */
  networks: readonly Network[];
  /** feePayer this facilitator can settle through, per network. Never taken from the payload. */
  feePayer: (network: Network) => bigint | undefined;
}

/**
 * The resource server's requirements must be well-formed: a missing field must never silently
 * disable a dependent check. `from` is only known once the payload is parsed.
 */
export function validateRequirements(req: unknown, ctx: RequirementsContext, from?: bigint): Requirements {
  if (!isObject(req)) return fail('invalid_payment_requirements');
  if (req.scheme !== SCHEME) fail('invalid_scheme');
  if (typeof req.network !== 'string' || !ctx.networks.includes(req.network as Network)) fail('invalid_network');
  const network = req.network as Network;

  if (typeof req.amount !== 'string' || !/^[0-9]+$/.test(req.amount) || BigInt(req.amount) >= U256) {
    fail('invalid_payment_requirements');
  }
  parseAddress(req.asset, 'invalid_payment_requirements');
  parseAddress(req.payTo, 'invalid_payment_requirements');
  const timeout = req.maxTimeoutSeconds;
  if (!Number.isSafeInteger(timeout) || BigInt(timeout as number) <= MIN_SETTLE_MARGIN) {
    fail('invalid_payment_requirements');
  }
  const extra = req.extra;
  if (!isObject(extra)) return fail('invalid_payment_requirements');
  const feePayer = parseAddress(extra.feePayer, 'invalid_payment_requirements');
  if (feePayer === 0n || feePayer === ANY_CALLER || (from !== undefined && feePayer === from)) {
    fail('invalid_payment_requirements');
  }
  // A feePayer this facilitator cannot settle through yields an authorization only someone else could run.
  if (ctx.feePayer(network) !== feePayer) fail('invalid_payment_requirements');
  if (extra.assetTransferMethod !== undefined && extra.assetTransferMethod !== 'default') {
    fail('invalid_payment_requirements');
  }
  if (extra.paymentFlow !== undefined && extra.paymentFlow !== 'authorization') {
    fail('invalid_payment_requirements');
  }
  return req as unknown as Requirements;
}

/** `accepted` (the client's echo) must equal the server's requirements, field by field. */
export function checkAccepted(accepted: unknown, req: Requirements): void {
  if (!isObject(accepted)) return fail('invalid_payload');
  if (accepted.scheme !== req.scheme) fail('invalid_scheme');
  if (accepted.network !== req.network) fail('invalid_network');
  const extra = accepted.extra;
  if (!isObject(extra)) return fail('invalid_payload');
  if (extra.assetTransferMethod !== undefined && extra.assetTransferMethod !== 'default') fail('invalid_payload');
  if (extra.paymentFlow !== undefined && extra.paymentFlow !== 'authorization') fail('invalid_payload');
  if (typeof accepted.amount !== 'string' || !/^[0-9]+$/.test(accepted.amount) ||
      BigInt(accepted.amount) !== BigInt(req.amount)) fail('invalid_payload');
  if (accepted.maxTimeoutSeconds !== req.maxTimeoutSeconds) fail('invalid_payload');
  if (parseAddress(accepted.asset) !== parseAddress(req.asset) ||
      parseAddress(accepted.payTo) !== parseAddress(req.payTo) ||
      parseAddress(extra.feePayer) !== parseAddress(req.extra.feePayer)) fail('invalid_payload');
}

// ---------------------------------------------------------------------------------------------
// Typed data (rule 2) and signature material (rule 3)
// ---------------------------------------------------------------------------------------------

export interface OutsideExecutionMessage {
  caller: bigint;
  nonce: bigint;
  executeAfter: bigint;
  executeBefore: bigint;
  calls: { to: bigint; selector: bigint; calldata: bigint[] }[];
}

export interface Canonical {
  /** The typed data rebuilt from the parsed values, the only thing ever hashed. */
  typedData: Record<string, unknown>;
  message: OutsideExecutionMessage;
}

const DOMAIN_TYPE = [
  { name: 'name', type: 'shortstring' }, { name: 'version', type: 'shortstring' },
  { name: 'chainId', type: 'shortstring' }, { name: 'revision', type: 'shortstring' },
];
const TYPES = {
  StarknetDomain: DOMAIN_TYPE,
  OutsideExecution: [
    { name: 'Caller', type: 'ContractAddress' }, { name: 'Nonce', type: 'felt' },
    { name: 'Execute After', type: 'u128' }, { name: 'Execute Before', type: 'u128' },
    { name: 'Calls', type: 'Call*' },
  ],
  Call: [
    { name: 'To', type: 'ContractAddress' }, { name: 'Selector', type: 'selector' },
    { name: 'Calldata', type: 'felt*' },
  ],
};

/**
 * Parses the client's typed data and rebuilds the canonical SNIP-9 v2 / SNIP-12 revision 1 message
 * from the parsed values. Unknown or missing keys, a v1 execution, or a chain id that is not the
 * one of `network` are refused.
 */
export function canonicalize(raw: unknown, network: Network): Canonical {
  if (!isObject(raw) || raw.primaryType !== 'OutsideExecution') return fail('invalid_payload');
  const domain = raw.domain;
  const message = raw.message;
  if (!isObject(domain) || !isObject(message)) return fail('invalid_payload');
  exactKeys(domain, ['name', 'version', 'chainId', 'revision']);
  exactKeys(message, ['Caller', 'Nonce', 'Execute After', 'Execute Before', 'Calls']);
  if (domain.name !== 'Account.execute_from_outside' || String(domain.version) !== '2' ||
      String(domain.revision) !== '1') fail('invalid_payload');
  const chainId = parseChainId(domain.chainId);
  if (chainId !== BigInt(CHAIN_ID[network])) fail('invalid_payload');

  const rawCalls = message.Calls;
  if (!Array.isArray(rawCalls)) return fail('invalid_payload');
  const calls = rawCalls.map((c) => {
    if (!isObject(c)) return fail('invalid_payload');
    exactKeys(c, ['To', 'Selector', 'Calldata']);
    if (!Array.isArray(c.Calldata)) return fail('invalid_payload');
    return {
      to: parseAddress(c.To), selector: parseFelt(c.Selector), calldata: c.Calldata.map((x) => parseFelt(x)),
    };
  });
  const parsed: OutsideExecutionMessage = {
    caller: parseAddress(message.Caller),
    nonce: parseFelt(message.Nonce),
    executeAfter: parseU128(message['Execute After']),
    executeBefore: parseU128(message['Execute Before']),
    calls,
  };
  return { typedData: buildTypedData(chainId, parsed), message: parsed };
}

function buildTypedData(chainId: bigint, m: OutsideExecutionMessage): Record<string, unknown> {
  return {
    types: TYPES,
    primaryType: 'OutsideExecution',
    domain: { name: 'Account.execute_from_outside', version: '2', chainId: hex(chainId), revision: '1' },
    message: {
      Caller: hex(m.caller), Nonce: hex(m.nonce),
      'Execute After': m.executeAfter.toString(), 'Execute Before': m.executeBefore.toString(),
      Calls: m.calls.map((c) => ({ To: hex(c.to), Selector: hex(c.selector), Calldata: c.calldata.map(hex) })),
    },
  };
}

/**
 * SNIP-12 message hash of the canonical typed data for the account `from`. The scheme's hash
 * exception (domain `version` and `revision` as the integers 2 and 1) is handled by starknet.js
 * for revision 1 typed data.
 */
export function messageHash(c: Canonical, from: bigint): string {
  return snTypedData.getMessageHash(c.typedData as any, hex(from));
}

/** The signature passed verbatim to `is_valid_signature`, as hex felts. Its length is bounded. */
export function parseSignature(sig: unknown): string[] {
  if (!Array.isArray(sig) || sig.length === 0 || sig.length > MAX_SIGNATURE_FELTS) return fail('invalid_payload');
  return sig.map((x) => hex(parseFelt(x)));
}

// ---------------------------------------------------------------------------------------------
// Caller (rule 4), time window (rule 5), intent (rule 7)
// ---------------------------------------------------------------------------------------------

export function checkCaller(m: OutsideExecutionMessage, req: Requirements): void {
  if (m.caller !== parseAddress(req.extra.feePayer)) fail('invalid_exact_starknet_payload_caller');
}

/**
 * `now` is Unix seconds. At `/verify` the authorization must be fresh (signed within skewMargin of
 * now); at `/settle` only the remaining-window floor and the upper bound apply, since the remaining
 * validity shrinks while the server prepares settlement.
 */
export function checkWindow(
  m: OutsideExecutionMessage, req: Requirements, now: bigint, phase: 'verify' | 'settle',
): void {
  const timeout = BigInt(req.maxTimeoutSeconds);
  if (phase === 'verify' && m.executeAfter >= now - SKEW_MARGIN) fail('invalid_payload');
  if (m.executeBefore <= now + MIN_SETTLE_MARGIN) fail('outside_execution_expired');
  if (phase === 'verify' && m.executeBefore < now + timeout - SKEW_MARGIN) fail('outside_execution_expired');
  if (m.executeBefore > now + timeout + SKEW_MARGIN) fail('outside_execution_window_exceeds_max_timeout');
}

/** Exactly one `transfer(payTo, amount)` on the required asset, nothing else. */
export function checkIntent(m: OutsideExecutionMessage, req: Requirements): void {
  if (m.calls.length !== 1) fail('invalid_payload');
  const call = m.calls[0];
  if (call.to !== parseAddress(req.asset)) fail('invalid_exact_starknet_payload_asset_mismatch');
  if (call.selector !== TRANSFER_SELECTOR) fail('invalid_payload');
  if (call.calldata.length !== 3) fail('invalid_payload');
  const [recipient, low, high] = call.calldata;
  if (low >= U128 || high >= U128) fail('invalid_payload');
  if (recipient !== parseAddress(req.payTo)) fail('invalid_exact_starknet_payload_recipient_mismatch');
  if (low + (high << 128n) !== BigInt(req.amount)) fail('invalid_exact_starknet_payload_amount_mismatch');
}

// ---------------------------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------------------------

export interface ParsedPayload {
  from: bigint;
  typedData: unknown;
  signature: string[];
}

/** `PaymentPayload` shape (core v2 section 5.2 plus this scheme's `payload`). */
export function parsePaymentPayload(p: unknown): { accepted: unknown; payload: ParsedPayload } {
  if (!isObject(p)) return fail('invalid_payload');
  if (p.x402Version !== X402_VERSION) fail('invalid_x402_version');
  const inner = p.payload;
  if (!isObject(inner) || !isObject(inner.outsideExecution)) return fail('invalid_payload');
  const oe = inner.outsideExecution;
  return {
    accepted: p.accepted,
    payload: { from: parseAddress(inner.from), typedData: oe.typedData, signature: parseSignature(oe.signature) },
  };
}

