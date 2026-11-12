/**
 * x402 demo client — a paying agent for a resource gated with the registered `exact` scheme on Starknet.
 *
 * Flow: request → 402 + PAYMENT-REQUIRED (price and the facilitator's feePayer) → sign a SNIP-9 v2
 * outside execution with `Caller = feePayer` (the payer pays no gas) → replay with PAYMENT-SIGNATURE →
 * resource + PAYMENT-RESPONSE. starknet.js 10.6.8 (pinned).
 */
import { Account, RpcProvider } from 'starknet';
import { signPayment } from './payment.js';

const ENDPOINT = process.env.X402_ENDPOINT ?? 'http://localhost:8000/x402/hello';
const RPC = process.env.STARKNET_RPC_URL ?? 'https://starknet-sepolia.public.blastapi.io';
const PAYER = process.env.PAYER_ADDRESS!;            // payer account, funded with the asset
const PAYER_PK = process.env.PAYER_PRIVATE_KEY!;     // payer private key — SECRET, never commit

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
const decode = (h: string | null) => (h ? JSON.parse(Buffer.from(h, 'base64').toString('utf8')) : undefined);

async function main() {
  const provider = new RpcProvider({ nodeUrl: RPC });
  const account = new Account({ provider, address: PAYER, signer: PAYER_PK });

  // 1) First call — expected: 402 and the PaymentRequired object (header, else body).
  let res = await fetch(ENDPOINT, { method: 'POST' });

  if (res.status === 402) {
    const challenge = decode(res.headers.get('PAYMENT-REQUIRED')) ?? await res.json();
    const req = challenge.accepts?.[0];
    console.log(`402 — to pay: ${req?.amount} atomic units of ${req?.asset} → ${req?.payTo} (sponsor ${req?.extra?.feePayer})`);

    // 2) Sign (the message is checked against the intent first) and replay with the payment attached.
    const payment = await signPayment(account, challenge);
    res = await fetch(ENDPOINT, { method: 'POST', headers: { 'PAYMENT-SIGNATURE': b64(payment) } });
  }

  console.log('Final status:', res.status);
  const settlement = decode(res.headers.get('PAYMENT-RESPONSE'));
  console.log(await res.json());
  if (settlement?.transaction) {
    console.log(`Settlement (${settlement.success ? 'settled' : settlement.errorReason}): https://sepolia.starkscan.co/tx/${settlement.transaction}`);
  }
  if (settlement && !settlement.success && settlement.errorReason === 'settlement_pending') {
    console.log('The payment may still land: reconcile that transaction on chain before paying again.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
