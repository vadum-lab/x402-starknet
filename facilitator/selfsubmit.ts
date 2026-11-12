/**
 * Facilitateur x402 Starknet — mode SELF-SUBMIT (POC, SANS AVNU/paymaster).
 *
 * Le payeur signe une **OutsideExecution SNIP-9** (méta-transaction) autorisant un `transfer` de l'actif (STRK/USDC)
 * vers `payTo`. N'IMPORTE QUEL compte peut la soumettre via `execute_from_outside_v2` — ici le
 * **facilitateur** la soumet et **paie le gas lui-même** (pas de paymaster, pas d'AVNU). Seule
 * dépendance externe : des comptes Starknet Sepolia financés (facilitateur pour le gas, payeur en
 * actif test) — tout via faucet, rien « sur demande ».
 *
 * Routes (schéma `exact` enregistré, ADR-0022) :
 *   GET  /supported  → { kinds: [{ …, extra: { feePayer } }], extensions, signers }
 *   POST /verify     { paymentPayload, paymentRequirements } → { isValid, invalidReason?, payer? }   (verify.ts)
 *   POST /settle     même corps → { success, transaction, network, payer?, errorReason? }            (settle.ts)
 *
 * ⚠️ POC non testé en live (comptes requis). starknet.js v10 ; adapter si l'API bouge.
 */
import express from 'express';
import { Account, RpcProvider, num } from 'starknet';
import { NETWORKS, parseAddress, type Network } from './scheme.js';
import { rpcChain, toOutsideTransaction } from './chain.js';
import { SettleCache, settlePayment, type SettleDeps } from './settle.js';
import { supported, verifyPayment, type VerifyDeps } from './verify.js';

const app = express();
app.use(express.json({ limit: '256kb' }));

const RPC = process.env.STARKNET_RPC_URL ?? 'https://starknet-sepolia.public.blastapi.io';
// Actif de règlement — défaut STRK Sepolia (18 déc.) ; mettre l'USDC Circle pour ce mode.
const ASSET = (process.env.X402_ASSET ??
  '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d').toLowerCase();
const PAY_TO = (process.env.X402_PAY_TO ?? '').toLowerCase();
const FAC_ADDRESS = process.env.FACILITATOR_ADDRESS!;   // compte facilitateur (financé pour le gas)
const FAC_PK = process.env.FACILITATOR_PRIVATE_KEY!;    // clé privée facilitateur — SECRET

const provider = new RpcProvider({ nodeUrl: RPC });
const facilitator = new Account({ provider, address: FAC_ADDRESS, signer: FAC_PK });

// Sérialisation des règlements : plusieurs /settle concurrents partageraient le MÊME nonce du compte
// facilitateur → une seule tx passerait (les autres « nonce conflict »). On suit le nonce localement
// (avancé à chaque soumission, resynchronisé depuis la chaîne en cas d'erreur) et on soumet dans un
// verrou. L'attente L2 (lente) reste HORS du verrou → les confirmations se font en parallèle.
let verrouSoumission: Promise<unknown> = Promise.resolve();
let nonceLocal: bigint | null = null;

async function soumettreSerialise(ot: any): Promise<string> {
  const precedent = verrouSoumission;
  let liberer!: () => void;
  verrouSoumission = new Promise<void>((r) => { liberer = r; });
  await precedent.catch(() => {});                    // attendre son tour (la précédente a libéré)
  try {
    if (nonceLocal === null) nonceLocal = num.toBigInt(await facilitator.getNonce());
    const nonce = nonceLocal;
    try {
      const { transaction_hash } = await facilitator.executeFromOutside(ot, { nonce });
      nonceLocal = nonce + 1n;                        // consommé → avancer
      return transaction_hash;
    } catch (e) {
      nonceLocal = null;                              // resync depuis la chaîne au prochain règlement
      throw e;
    }
  } finally {
    liberer();
  }
}

const NETWORK = (process.env.X402_NETWORK ?? 'starknet:SN_SEPOLIA') as Network;
if (!NETWORKS.includes(NETWORK)) throw new Error(`X402_NETWORK must be one of ${NETWORKS.join(', ')}`);
const optionalAddress = (v?: string) => (v ? parseAddress(v) : undefined);

const deps: VerifyDeps = {
  chain: rpcChain(provider, facilitator),
  network: NETWORK,
  feePayer: parseAddress(FAC_ADDRESS),      // the executor account is the announced feePayer
  asset: optionalAddress(process.env.X402_ASSET),
  payTo: optionalAddress(process.env.X402_PAY_TO),
  now: () => BigInt(Math.floor(Date.now() / 1000)),
  log: (m) => console.error(`[verify] ${m}`),
};

app.get('/supported', (_req, res) => res.json(supported(deps)));

app.post('/verify', async (req, res) => res.json(await verifyPayment(deps, req.body)));

const settleDeps: SettleDeps = {
  ...deps,
  submit: (from, message, signature) => soumettreSerialise(toOutsideTransaction(from, message, signature)),
  cache: new SettleCache(),
  waitMs: Number(process.env.X402_SETTLE_WAIT_MS ?? 60_000),
};

app.post('/settle', async (req, res) => res.json(await settlePayment(settleDeps, req.body)));

app.get('/health', async (_req, res) => {
  res.json({ ok: true, mode: 'self-submit', facilitator: FAC_ADDRESS, payTo: PAY_TO, asset: ASSET });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () =>
  console.log(`[x402-facilitator self-submit] :${port} — soumet l'OutsideExecution, paie le gas`));

// Note utile pour l'aller-retour BigInt côté JSON : le client sérialise les felts en hex string ;
// starknet.js accepte les BigNumberish string, donc `executeFromOutside(ot)` fonctionne tel quel.
