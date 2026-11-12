/**
 * Client side of the `exact` scheme on Starknet: build the SNIP-9 v2 outside execution the 402 asks
 * for, check it against the client's own intent, sign it, and wrap it in a PaymentPayload.
 * No network access: the signature is made locally, the facilitator is never contacted.
 */
import { CallData, cairo, constants, hash, outsideExecution, shortString, type Account } from 'starknet';

export interface Requirements {
  scheme: string; network: string; amount: string; asset: string; payTo: string;
  maxTimeoutSeconds: number; extra: { feePayer: string; [k: string]: unknown };
}

const CHAIN_IDS: Record<string, string> = {
  'starknet:SN_MAIN': constants.StarknetChainId.SN_MAIN,
  'starknet:SN_SEPOLIA': constants.StarknetChainId.SN_SEPOLIA,
};
const ANY_CALLER = BigInt(constants.OutsideExecutionCallerAny);
const TRANSFER_SELECTOR = BigInt(hash.getSelectorFromName('transfer'));
const U128 = (1n << 128n) - 1n;
const num = (v: unknown) => BigInt(v as string);
/** A felt given as hex, decimal, or a short string (`SN_MAIN`), the three forms a chain id may take. */
const felt = (v: unknown) => (/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(String(v)) ? BigInt(v as string) : BigInt(shortString.encodeShortString(String(v))));

/** The 402 entry this client can pay, or throw. A forbidden feePayer is refused before any signing. */
export function chooseRequirements(accepts: unknown, payer: string): Requirements {
  const req = (Array.isArray(accepts) ? accepts : []).find(
    (a: any) => a?.scheme === 'exact' && typeof a?.network === 'string' && a.network in CHAIN_IDS);
  if (!req) throw new Error('no Starknet exact entry in the 402');
  if (!/^[0-9]+$/.test(req.amount)) throw new Error('amount is not a base-10 string');
  if (!Number.isSafeInteger(req.maxTimeoutSeconds) || req.maxTimeoutSeconds <= 0) throw new Error('bad maxTimeoutSeconds');
  const feePayer = req.extra?.feePayer;
  if (typeof feePayer !== 'string') throw new Error('extra.feePayer is required');
  const fp = num(feePayer);
  if (fp === 0n || fp === ANY_CALLER || fp === num(payer)) throw new Error('forbidden feePayer');
  return req;
}

/** A fresh SNIP-9 nonce: 31 random bytes, always a valid felt. */
export const randomNonce = () => '0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(31))).toString('hex');

export function buildTypedData(req: Requirements, nonce: string, nowSeconds: number) {
  const transfer = {
    contractAddress: req.asset,
    entrypoint: 'transfer',
    calldata: CallData.compile({ recipient: req.payTo, amount: cairo.uint256(req.amount) }),
  };
  // structuredClone: starknet.js returns its shared type tables, which must never be mutated.
  return structuredClone(outsideExecution.getTypedData(
    CHAIN_IDS[req.network],
    { caller: req.extra.feePayer, execute_after: 1, execute_before: nowSeconds + req.maxTimeoutSeconds },
    nonce, [transfer], '2',
  )) as any;
}

/**
 * The signature authorizes exactly what the message says, so the final message is checked against
 * the intent before signing: one `transfer(payTo, amount)` on the asset, Caller = feePayer, time bounds.
 */
export function assertIntent(td: any, req: Requirements, payer: string, nowSeconds: number): void {
  const m = td?.message;
  const fail = (what: string): never => { throw new Error(`refusing to sign: ${what}`); };
  if (td?.primaryType !== 'OutsideExecution' || td?.domain?.revision?.toString() !== '1' ||
      td?.domain?.version?.toString() !== '2') fail('not a SNIP-9 v2 outside execution');
  if (felt(td.domain.chainId) !== num(CHAIN_IDS[req.network])) fail('wrong chain');
  if (!m || Object.keys(m).length !== 5) fail('unexpected message fields');
  const caller = num(m.Caller);
  if (caller !== num(req.extra.feePayer) || caller === ANY_CALLER || caller === 0n || caller === num(payer)) fail('Caller is not the feePayer');
  if (!Array.isArray(m.Calls) || m.Calls.length !== 1) fail('not exactly one call');
  const c = m.Calls[0];
  if (num(c.To) !== num(req.asset)) fail('wrong asset');
  if (num(c.Selector) !== TRANSFER_SELECTOR) fail('not a transfer');
  const cd = c.Calldata;
  if (!Array.isArray(cd) || cd.length !== 3) fail('bad calldata');
  const [recipient, low, high] = cd.map(num);
  if (recipient !== num(req.payTo)) fail('wrong recipient');
  if (low > U128 || high > U128 || low + (high << 128n) !== BigInt(req.amount)) fail('wrong amount');
  if (num(m['Execute Before']) !== BigInt(nowSeconds + req.maxTimeoutSeconds)) fail('wrong Execute Before');
  if (num(m['Execute After']) >= BigInt(nowSeconds)) fail('Execute After is not in the past');
}

/** A starknet.js signature as the array of hex felts the scheme carries. */
export function signatureFelts(sig: unknown): string[] {
  const felts = Array.isArray(sig) ? sig : [(sig as any).r, (sig as any).s];
  return felts.map((x) => '0x' + BigInt(x).toString(16));
}

export async function signPayment(
  account: Pick<Account, 'address' | 'signMessage'>, challenge: any, nowSeconds = Math.floor(Date.now() / 1000),
  nonce = randomNonce(),
) {
  const accepted = chooseRequirements(challenge?.accepts, account.address);
  const typedData = buildTypedData(accepted, nonce, nowSeconds);
  assertIntent(typedData, accepted, account.address, nowSeconds);
  const signature = signatureFelts(await account.signMessage(typedData));
  return {
    x402Version: 2,
    ...(challenge.resource ? { resource: challenge.resource } : {}),
    accepted,
    payload: { from: account.address, outsideExecution: { typedData, signature } },
  };
}
