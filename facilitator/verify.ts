/**
 * `/verify` and `/supported` of the `exact` scheme on Starknet (rules 1 to 8).
 * Pure orchestration over `scheme.ts` rules and a `Chain`; no HTTP, no globals.
 */
import {
  CHAIN_ID, SCHEME, X402_VERSION, SchemeError, canonicalize, checkAccepted, checkCaller, checkIntent, checkWindow,
  hex, messageHash, parseAddress, parsePaymentPayload, validateRequirements,
  type ErrorCode, type Network, type Requirements,
} from './scheme.js';
import { Unavailable, type Chain } from './chain.js';
import { payerTransferIsExact } from './transfers.js';

const VALID = 0x56414c4944n;   // SNIP-6 magic value
const U128 = 2n ** 128n;

export interface VerifyDeps {
  chain: Chain;
  network: Network;
  /** The executor account: announced as feePayer, and the only submitter. Trusted configuration. */
  feePayer: bigint;
  /** Optional allow-list: when set, only this asset / recipient is served. */
  asset?: bigint;
  payTo?: bigint;
  /** Unix seconds. */
  now: () => bigint;
  log?: (msg: string) => void;
}

export type VerifyResponse =
  | { isValid: true; payer: string }
  | { isValid: false; invalidReason: ErrorCode; payer?: string };

export function supported(d: VerifyDeps) {
  return {
    kinds: [{ x402Version: X402_VERSION, scheme: SCHEME, network: d.network, extra: { feePayer: hex(d.feePayer) } }],
    extensions: [],
    signers: { 'starknet:*': [hex(d.feePayer)] },
  };
}

const u256 = (r: string[]) => {
  if (r.length !== 2) throw new Unavailable('malformed u256');
  const [low, high] = r.map((x) => BigInt(x));
  if (low >= U128 || high >= U128) throw new Unavailable('malformed u256');
  return low + (high << 128n);
};

/**
 * Everything verification needs from a request, already parsed and rule-checked up to (and
 * excluding) the chain reads. `/settle` re-runs it: a prior `/verify` is never trusted.
 */
export function precheck(d: VerifyDeps, body: unknown, phase: 'verify' | 'settle' | 'none') {
  const b = (body ?? {}) as Record<string, unknown>;
  const { accepted, payload } = parsePaymentPayload(b.paymentPayload);
  const ctx = { networks: [d.network] as const, feePayer: () => d.feePayer };
  const req: Requirements = validateRequirements(b.paymentRequirements, ctx, payload.from);
  if (d.asset !== undefined && parseAddress(req.asset) !== d.asset) throw new SchemeError('invalid_payment_requirements');
  if (d.payTo !== undefined && parseAddress(req.payTo) !== d.payTo) throw new SchemeError('invalid_payment_requirements');
  checkAccepted(accepted, req);
  const canonical = canonicalize(payload.typedData, req.network);
  checkCaller(canonical.message, req);
  if (phase !== 'none') checkWindow(canonical.message, req, d.now(), phase);
  checkIntent(canonical.message, req);
  return { req, payload, canonical };
}

/** Chain reads of rules 3, 6 and 8, in the order of the scheme. Returns once the payer is authenticated. */
export async function chainChecks(d: VerifyDeps, p: ReturnType<typeof precheck>, onSigned: () => void) {
  const { req, payload, canonical } = p;
  const { chain } = d;
  const from = payload.from;
  const asset = parseAddress(req.asset);
  const amount = BigInt(req.amount);

  // The node must be on the network the requirements name; otherwise nothing it says counts.
  if (BigInt(await chain.chainId()) !== BigInt(CHAIN_ID[req.network])) throw new Unavailable('connected to another network');
  if (!(await chain.isDeployed(from))) throw new SchemeError('account_not_deployed');

  const sig = await chain.call(from, 'is_valid_signature',
    [messageHash(canonical, from), hex(BigInt(payload.signature.length)), ...payload.signature]);
  if (!sig.ok || sig.result.length < 1 || BigInt(sig.result[0]) !== VALID) {
    throw new SchemeError('invalid_exact_starknet_payload_signature');
  }
  onSigned();

  const nonce = await chain.call(from, 'is_valid_outside_execution_nonce', [hex(canonical.message.nonce)]);
  if (!nonce.ok || nonce.result.length < 1 || BigInt(nonce.result[0]) === 0n) throw new SchemeError('nonce_already_used');

  let bal = await chain.call(asset, 'balance_of', [hex(from)]);
  if (!bal.ok) bal = await chain.call(asset, 'balanceOf', [hex(from)]);
  if (!bal.ok) throw new SchemeError('invalid_payment_requirements');   // neither getter
  if (u256(bal.result) < amount) throw new SchemeError('insufficient_funds');

  const events = await chain.simulateSettlement(from, canonical.message, payload.signature);
  if (events === 'reverted' ||
      !payerTransferIsExact(events, asset, from, parseAddress(req.payTo), amount)) {
    throw new SchemeError('simulation_failed');
  }
}

export async function verifyPayment(d: VerifyDeps, body: unknown): Promise<VerifyResponse> {
  let signedPayer: string | undefined;
  try {
    const p = precheck(d, body, 'verify');
    await chainChecks(d, p, () => { signedPayer = hex(p.payload.from); });
    return { isValid: true, payer: signedPayer! };
  } catch (e) {
    // `payer` is only echoed once its signature was verified, never from client input.
    const payer = signedPayer ? { payer: signedPayer } : {};
    if (e instanceof SchemeError) return { isValid: false, invalidReason: e.code, ...payer };
    d.log?.(`verify: ${e instanceof Error ? e.message : String(e)}`);   // raw text stays server-side
    return { isValid: false, invalidReason: 'unexpected_verify_error', ...payer };
  }
}
