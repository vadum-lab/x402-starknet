/**
 * Minimal x402 server — gates a resource behind an on-chain payment on Starknet.
 * Registered `exact` scheme, x402 v2 over HTTP (transport headers PAYMENT-REQUIRED / PAYMENT-SIGNATURE /
 * PAYMENT-RESPONSE).
 *
 *   no PAYMENT-SIGNATURE header  → 402 + PAYMENT-REQUIRED (the price and the facilitator's feePayer)
 *   with PAYMENT-SIGNATURE       → facilitator /verify then /settle; on success, serve the resource
 *
 * The server holds NO keys and does NO crypto. It builds the requirements itself, copying `feePayer`
 * verbatim from its facilitator's /supported, and never takes requirements from the client.
 */
import express from 'express';

const app = express();
app.use(express.json({ limit: '256kb' }));

const FACILITATOR = process.env.FACILITATOR_URL ?? 'http://localhost:3402';
const PAY_TO = process.env.X402_PAY_TO ?? '';
const ASSET = process.env.X402_ASSET
  ?? '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d'; // STRK Sepolia (public)
const NETWORK = process.env.X402_NETWORK ?? 'starknet:SN_SEPOLIA';
const AMOUNT = process.env.X402_AMOUNT ?? '50000000000000000';   // atomic units (default 0.05 STRK, 18 dec)
const MAX_TIMEOUT_SECONDS = Number(process.env.X402_MAX_TIMEOUT_SECONDS ?? 300);
const FEE_PAYER_TTL_MS = 30_000;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');

let feePayerCache: { value: string; at: number } | undefined;

/** The sponsor address, verbatim from the facilitator's /supported entry for this network. */
async function feePayer(): Promise<string> {
  if (feePayerCache && Date.now() - feePayerCache.at < FEE_PAYER_TTL_MS) return feePayerCache.value;
  const supported: any = await (await fetch(`${FACILITATOR}/supported`)).json();
  const kind = (supported?.kinds ?? []).find(
    (k: any) => k?.scheme === 'exact' && k?.network === NETWORK && typeof k?.extra?.feePayer === 'string');
  if (!kind) throw new Error(`facilitator does not support exact on ${NETWORK}`);
  feePayerCache = { value: kind.extra.feePayer, at: Date.now() };
  return feePayerCache.value;
}

/** x402 v2 PaymentRequirements for the gated resource. */
function requirements(sponsor: string) {
  return {
    scheme: 'exact',
    network: NETWORK,
    amount: AMOUNT,                 // atomic string
    asset: ASSET,
    payTo: PAY_TO,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { feePayer: sponsor },
  };
}

/** The protected resource. Replace with your own logic. */
function resource() {
  return { result: `🔓 unlocked at ${new Date().toISOString()}` };
}

const paymentRequired = (req: express.Request, sponsor: string, error: string) => ({
  x402Version: 2,
  error,
  resource: { url: `${req.protocol}://${req.get('host')}${req.originalUrl}`, mimeType: 'application/json' },
  accepts: [requirements(sponsor)],
});

app.post('/x402/hello', async (req, res) => {
  let sponsor: string;
  try {
    sponsor = await feePayer();
  } catch (e) {
    console.error(`[x402 server] facilitator unavailable: ${e instanceof Error ? e.message : e}`);
    return res.status(502).json({ error: 'payment facilitator unavailable' });
  }
  const challenge = (error: string) => {
    const body = paymentRequired(req, sponsor, error);
    return res.status(402).set('PAYMENT-REQUIRED', b64(body)).json(body);
  };

  // 1) Not paid yet → answer 402 with the price.
  const header = req.header('PAYMENT-SIGNATURE');
  if (!header) return challenge('PAYMENT-SIGNATURE header is required');

  // 2) Payment presented → decode, then verify + settle via the facilitator.
  let paymentPayload: unknown;
  try {
    paymentPayload = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'invalid PAYMENT-SIGNATURE (expected base64-encoded JSON)' });
  }
  // Always this server's own requirements: whatever the client sends is untrusted, including the price.
  const body = JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: requirements(sponsor) });
  const post = async (path: string): Promise<any> => {
    const r = await fetch(`${FACILITATOR}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    return r.json();
  };

  let verify: any;
  try { verify = await post('/verify'); } catch (e) {
    console.error(`[x402 server] /verify failed: ${e instanceof Error ? e.message : e}`);
    return res.status(502).json({ error: 'payment facilitator unavailable' });
  }
  if (!verify?.isValid) return failure(verify?.invalidReason, challenge);

  let settle: any;
  try { settle = await post('/settle'); } catch (e) {
    // The outcome is unknown: the transaction may have been broadcast. Say so, do not invite a blind retry.
    console.error(`[x402 server] /settle failed: ${e instanceof Error ? e.message : e}`);
    return res.status(502).json({ error: 'settlement outcome unknown' });
  }
  if (!settle?.success) {
    // A non-terminal settlement_pending carries the hash: the client reconciles on chain before re-paying.
    res.set('PAYMENT-RESPONSE', b64(settle ?? {}));
    return failure(settle?.errorReason, challenge);
  }

  // 3) Paid → serve the resource, with the settlement response (transaction hash).
  res.set('PAYMENT-RESPONSE', b64(settle)).json({ ...resource(), transaction: settle.transaction });

  /** Malformed payment → 400; unexpected → 500; a payment that failed → 402 with a fresh challenge. */
  function failure(reason: string | undefined, again: (error: string) => unknown) {
    const code = typeof reason === 'string' ? reason : 'unexpected_error';
    if (['invalid_payload', 'invalid_x402_version', 'invalid_scheme', 'invalid_network'].includes(code)) {
      return res.status(400).json({ error: code });
    }
    if (code.startsWith('unexpected_') || code === 'invalid_payment_requirements') {
      return res.status(500).json({ error: code });
    }
    return again(code);
  }
});

app.get('/health', (_req, res) =>
  res.json({ ok: true, network: NETWORK, payTo: PAY_TO, asset: ASSET, amount: AMOUNT, facilitator: FACILITATOR }));

const port = Number(process.env.PORT ?? 8000);
app.listen(port, () =>
  console.log(`[x402 example server] :${port} — POST /x402/hello returns 402 until paid`));
