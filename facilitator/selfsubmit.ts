/**
 * Facilitateur x402 Starknet — mode SELF-SUBMIT (POC, SANS AVNU/paymaster).
 *
 * Le payeur signe une **OutsideExecution SNIP-9** (méta-transaction) autorisant un `transfer` de l'actif (STRK/USDC)
 * vers `payTo`. N'IMPORTE QUEL compte peut la soumettre via `execute_from_outside_v2` — ici le
 * **facilitateur** la soumet et **paie le gas lui-même** (pas de paymaster, pas d'AVNU). Seule
 * dépendance externe : des comptes Starknet Sepolia financés (facilitateur pour le gas, payeur en
 * actif test) — tout via faucet, rien « sur demande ».
 *
 * Endpoints attendus par le gate Python (`core/.../x402/facilitator_client.py`) :
 *   POST /verify  { payload, requirements } -> { valid, payer, reason }
 *   POST /settle  { payload, requirements } -> { success, txHash, reason }
 * ``payload`` = PaymentPayload x402 : { payload: { authorization, outsideTransaction } }.
 * ``outsideTransaction`` = objet produit par starknet.js `getOutsideTransaction` côté client.
 *
 * ⚠️ POC non testé en live (comptes requis). starknet.js v10 ; adapter si l'API bouge.
 */
import express from 'express';
import { Account, RpcProvider, Contract, cairo, num } from 'starknet';

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

const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', state_mutability: 'view',
    inputs: [{ name: 'account', type: 'core::starknet::contract_address::ContractAddress' }],
    outputs: [{ type: 'core::integer::u256' }] },
];

/** Vérifie qu'une OutsideExecution transfère bien ``amount`` de l'actif vers ``PAY_TO`` (structurel). */
function callsTransfereBien(outsideExecution: any, amountAtomic: bigint): boolean {
  const calls = outsideExecution?.calls ?? [];
  if (calls.length !== 1) return false;
  const c = calls[0];
  // Adresses comparées en BigInt : un felt ignore les zéros de tête (0x0433… === 0x433…).
  const to = num.toBigInt(c.to ?? c.contractAddress ?? 0);
  // calldata d'un transfer(recipient, amount:u256) = [recipient, low, high]
  const cd = (c.calldata ?? []).map((x: any) => num.toBigInt(x));
  if (to !== num.toBigInt(ASSET) || cd.length < 3) return false;
  const recipient = cd[0];
  const montant = cd[1] + (cd[2] << 128n);   // u256 low + high
  return recipient === num.toBigInt(PAY_TO) && montant === amountAtomic;
}

app.post('/verify', async (req, res) => {
  try {
    const { payload } = req.body ?? {};
    const inner = payload?.payload ?? {};
    const auth = inner?.authorization ?? {};
    const ot = inner?.outsideTransaction;
    if (!ot || !auth?.from || auth?.amount == null) {
      return res.json({ valid: false, reason: 'payload_incomplet' });
    }
    const amount = num.toBigInt(auth.amount);
    if (!callsTransfereBien(ot.outsideExecution, amount)) {
      return res.json({ valid: false, reason: 'calls_non_conformes' });
    }
    // bornes temporelles
    const now = BigInt(Math.floor(Date.now() / 1000));
    const before = num.toBigInt(ot.outsideExecution?.execute_before ?? auth.validUntil ?? 0);
    if (before !== 0n && now > before) return res.json({ valid: false, reason: 'expire' });
    // solde de l'actif du payeur suffisant
    const token = new Contract({ abi: ERC20_ABI as any, address: ASSET, providerOrAccount: provider });
    const bal = num.toBigInt((await token.balanceOf(auth.from)).toString());
    if (bal < amount) return res.json({ valid: false, reason: 'solde_actif_insuffisant' });
    // la validité de la SIGNATURE est enforced à /settle (la chaîne rejette une sig invalide).
    res.json({ valid: true, payer: auth.from, reason: null });
  } catch (e: any) {
    res.status(200).json({ valid: false, reason: `verify_error:${e?.message ?? 'unknown'}` });
  }
});

app.post('/settle', async (req, res) => {
  try {
    const ot = req.body?.payload?.payload?.outsideTransaction;
    if (!ot) return res.status(200).json({ success: false, reason: 'outside_transaction_absente' });
    // Le facilitateur soumet l'OutsideExecution du payeur — il paie le gas (pas de paymaster).
    // Soumission SÉRIALISÉE (nonce séquentiel) pour supporter des règlements concurrents.
    const transaction_hash = await soumettreSerialise(ot);
    console.log(`[settle] executeFromOutside → ${transaction_hash} (attente ACCEPTED_ON_L2…)`);
    await provider.waitForTransaction(transaction_hash);   // hors verrou → confirmations en parallèle
    console.log(`[settle] réglé : https://sepolia.starkscan.co/tx/${transaction_hash}`);
    res.json({ success: true, txHash: transaction_hash });
  } catch (e: any) {
    res.status(200).json({ success: false, reason: `settle_error:${e?.message ?? 'unknown'}` });
  }
});

app.get('/health', async (_req, res) => {
  res.json({ ok: true, mode: 'self-submit', facilitator: FAC_ADDRESS, payTo: PAY_TO, asset: ASSET });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () =>
  console.log(`[x402-facilitator self-submit] :${port} — soumet l'OutsideExecution, paie le gas`));

// Note utile pour l'aller-retour BigInt côté JSON : le client sérialise les felts en hex string ;
// starknet.js accepte les BigNumberish string, donc `executeFromOutside(ot)` fonctionne tel quel.
void cairo;  // gardé pour extension (compile de calldata côté verify si besoin)
