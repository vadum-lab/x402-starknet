/**
 * Client de démo x402 — mode SELF-SUBMIT (POC, SANS AVNU).
 *
 * L'« agent » signe une OutsideExecution SNIP-9 autorisant un `transfer` de l'actif vers payTo, et la
 * transmet dans l'en-tête PAYMENT-SIGNATURE. Le facilitateur la soumet et paie le gas.
 * starknet.js v10.6.8 (épinglé) ; `caller: 'ANY_CALLER'`.
 */
import { Account, RpcProvider, CallData, cairo } from 'starknet';

const ENDPOINT = process.env.X402_ENDPOINT ?? 'http://localhost:8000/api/v1/x402/generer-texte';
const RPC = process.env.STARKNET_RPC_URL ?? 'https://starknet-sepolia.public.blastapi.io';
const PAYER = process.env.PAYER_ADDRESS!;            // compte payeur (financé en USDC test)
const PAYER_PK = process.env.PAYER_PRIVATE_KEY!;     // clé privée payeur — SECRET, jamais commit

// Sérialise les BigInt en hex string (starknet.js accepte les BigNumberish string au ré-import).
const bigintReplacer = (_k: string, v: any) => (typeof v === 'bigint' ? '0x' + v.toString(16) : v);

async function main() {
  const provider = new RpcProvider({ nodeUrl: RPC });
  const account = new Account({ provider, address: PAYER, signer: PAYER_PK });
  // Prompt UNIQUE (horodaté) pour éviter le cache LLM → coût métré non nul. Tier optionnel (X402_TIER).
  const prompt = process.env.X402_PROMPT ?? `Explique le mycélium en une phrase originale (#${Date.now()}).`;
  const tier = process.env.X402_TIER;
  const body = JSON.stringify(tier ? { prompt, tier } : { prompt });

  // 1) Premier appel — attendu : 402 + PaymentRequirements.
  let res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Payer': PAYER },
    body,
  });

  if (res.status === 402) {
    const challenge = await res.json();
    const req = challenge.accepts[0];
    const amount = BigInt(req.amount);
    console.log(`402 — à payer : ${amount} atomic USDC (${req.asset}) → payTo ${req.payTo}`);

    // 2) OutsideExecution SNIP-9 : autorise transfer(payTo, amount) sur le token USDC.
    const transfer = {
      contractAddress: req.asset,
      entrypoint: 'transfer',
      calldata: CallData.compile({ recipient: req.payTo, amount: cairo.uint256(amount) }),
    };
    const now = Math.floor(Date.now() / 1000);
    const ot = await account.getOutsideTransaction(
      { caller: 'ANY_CALLER', execute_after: 0, execute_before: now + (req.maxTimeoutSeconds ?? 300) },
      [transfer],
    );

    // 3) PaymentPayload x402 (authorization pour le gate Python + outsideTransaction pour le facilitateur).
    const authorization = {
      from: PAYER, to: req.payTo, amount: amount.toString(), token: req.asset,
      nonce: String(ot.outsideExecution?.nonce ?? ''), validUntil: String(now + (req.maxTimeoutSeconds ?? 300)),
    };
    const payment = {
      payload: { x402Version: 2, scheme: 'exact', payload: { authorization, outsideTransaction: ot } },
      requirements: req,
    };
    const header = Buffer.from(JSON.stringify(payment, bigintReplacer)).toString('base64');

    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Payer': PAYER, 'PAYMENT-SIGNATURE': header },
      body,
    });
  }

  console.log('Statut final :', res.status);
  const out = await res.json();
  console.log(out);
  if (out?.reglement_tx) {
    console.log(`Règlement on-chain : https://sepolia.starkscan.co/tx/${out.reglement_tx}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
