/**
 * NOT MIGRATED to the registered `exact` scheme (ADR-0022 leaves the AVNU mode undecided).
 * This file still speaks the pre-scheme format and is not typechecked or tested by CI. Use the default
 * self-submit entry point (`npm start`).
 */
/**
 * Client de démo x402 (POC) — un « agent » qui paie une ressource protégée par x402 sur Starknet.
 *
 * Flux : POST l'endpoint gaté → reçoit 402 + PaymentRequirements → signe l'autorisation SNIP-9
 * (paquet `x402-starknet`) → rejoue avec l'en-tête PAYMENT-SIGNATURE → reçoit le résultat.
 * ⚠️ POC : adapter les imports/fonctions à la version installée de `x402-starknet`.
 */
import { Account, RpcProvider } from 'starknet';
import { createPaymentPayload } from 'x402-starknet';

const ENDPOINT = process.env.X402_ENDPOINT ?? 'http://localhost:8000/api/v1/x402/generer-texte';
const RPC = process.env.STARKNET_RPC_URL ?? 'https://starknet-sepolia.public.blastapi.io';
const ACCOUNT_ADDRESS = process.env.PAYER_ADDRESS!;     // compte payeur (financé en USDC test)
const ACCOUNT_PK = process.env.PAYER_PRIVATE_KEY!;      // clé privée du payeur (jamais commit)
const PAYMASTER_ENDPOINT = process.env.PAYMASTER_ENDPOINT!;

async function main() {
  const provider = new RpcProvider({ nodeUrl: RPC });
  const account = new Account(provider, ACCOUNT_ADDRESS, ACCOUNT_PK);
  const body = JSON.stringify({ prompt: 'Say hello in one sentence.' });

  // 1) Premier appel — attendu : 402 Payment Required.
  let res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Payer': ACCOUNT_ADDRESS },
    body,
  });
  if (res.status === 402) {
    const challenge = await res.json();
    const requirements = challenge.accepts[0];
    console.log('402 reçu — à payer :', requirements.amount, 'atomic USDC → payTo', requirements.payTo);

    // 2) Signe l'autorisation de paiement (SNIP-9) et rejoue avec l'en-tête.
    const payload = await createPaymentPayload(account, requirements, {
      paymasterEndpoint: PAYMASTER_ENDPOINT,
    });
    const header = Buffer.from(JSON.stringify({ payload, requirements })).toString('base64');
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payer': ACCOUNT_ADDRESS,
        'PAYMENT-SIGNATURE': header,
      },
      body,
    });
  }

  console.log('Statut final :', res.status);
  console.log(await res.json());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
