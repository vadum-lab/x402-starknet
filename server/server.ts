/**
 * Minimal x402 server — gates a resource behind an on-chain payment on Starknet.
 *
 *   no PAYMENT-SIGNATURE header  → 402 + PaymentRequirements (the price)
 *   with PAYMENT-SIGNATURE       → verify + settle via the facilitator; on success, serve the resource
 *
 * The server holds NO keys and does NO crypto: it emits the 402 and relays the payment to the
 * facilitator (this repo's `facilitator/`), which verifies the SNIP-9 authorization and settles
 * it on Starknet. Point your client's endpoint at POST /x402/hello.
 */
import express from 'express';

const app = express();
app.use(express.json({ limit: '256kb' }));

const FACILITATOR = process.env.FACILITATOR_URL ?? 'http://localhost:3402';
const PAY_TO = process.env.X402_PAY_TO ?? '';
const ASSET = process.env.X402_ASSET
  ?? '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d'; // STRK Sepolia (public)
const NETWORK = process.env.X402_NETWORK ?? 'starknet:sepolia';
const AMOUNT = process.env.X402_AMOUNT ?? '50000000000000000';   // atomic units (default 0.05 STRK, 18 dec)
const SYMBOL = process.env.X402_ASSET_SYMBOL ?? 'STRK';
const DECIMALS = Number(process.env.X402_ASSET_DECIMALS ?? 18);

/** x402 v2 PaymentRequirements for the gated resource. */
function requirements(resource: string) {
  return {
    scheme: 'exact',
    network: NETWORK,
    asset: ASSET,
    payTo: PAY_TO,
    amount: AMOUNT,                 // atomic string
    resource,
    maxTimeoutSeconds: 300,
    extra: { symbol: SYMBOL, decimals: DECIMALS },
  };
}

/** The protected resource. Replace with your own logic. */
function resource() {
  return { result: `🔓 unlocked at ${new Date().toISOString()}` };
}

app.post('/x402/hello', async (req, res) => {
  const header = req.header('PAYMENT-SIGNATURE');

  // 1) Not paid yet → answer 402 with the price.
  if (!header) {
    return res.status(402).json({ x402Version: 2, accepts: [requirements('/x402/hello')] });
  }

  // 2) Payment presented → decode, then verify + settle via the facilitator.
  let payment: any;
  try {
    payment = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'invalid PAYMENT-SIGNATURE (expected base64-encoded JSON)' });
  }
  // Always this server's own requirements: whatever the client sends is untrusted, including the price.
  const body = JSON.stringify({
    payload: payment.payload,
    requirements: requirements('/x402/hello'),
  });
  const post = (path: string) =>
    fetch(`${FACILITATOR}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      .then((r) => r.json());

  const verify = await post('/verify').catch((e) => ({ valid: false, reason: String(e) }));
  if (!verify.valid) {
    return res.status(402).json({ error: 'payment not valid', reason: verify.reason, accepts: [requirements('/x402/hello')] });
  }
  const settle = await post('/settle').catch((e) => ({ success: false, reason: String(e) }));
  if (!settle.success) {
    return res.status(402).json({ error: 'settlement failed', reason: settle.reason });
  }

  // 3) Paid → serve the resource (echo the on-chain settlement tx).
  res.json({ ...resource(), reglement_tx: settle.txHash });
});

app.get('/health', (_req, res) =>
  res.json({ ok: true, payTo: PAY_TO, asset: ASSET, amount: AMOUNT, facilitator: FACILITATOR }));

const port = Number(process.env.PORT ?? 8000);
app.listen(port, () =>
  console.log(`[x402 example server] :${port} — POST /x402/hello returns 402 until paid`));
