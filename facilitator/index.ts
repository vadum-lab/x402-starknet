/**
 * NOT MIGRATED to the registered `exact` scheme (ADR-0022 leaves the AVNU mode undecided).
 * This file still speaks the pre-scheme format and is not typechecked or tested by CI. Use the default
 * self-submit entry point (`npm start`).
 */
/**
 * Facilitateur x402 Starknet (POC) — sidecar Node.
 *
 * Expose /verify et /settle attendus par le gate Python (`core/.../x402/facilitator_client.py`).
 * Délègue au paquet `x402-starknet` (NethermindEth) : `verifyPayment` (signature SNIP-6, solde,
 * anti-rejeu) puis `settlePayment` via le paymaster AVNU (SNIP-9 Outside Execution, gasless).
 *
 * ⚠️ POC : miroir de `NethermindEth/x402-starknet` examples/facilitator-service.ts — adapter les
 * imports à la version installée. Chemin AVNU (lib native) ; le fallback self-submit (sans AVNU)
 * est décrit dans le README (à implémenter si l'accès testnet AVNU tarde).
 */
import express from 'express';
// Adapter aux exports réels de la version installée de `x402-starknet` :
import { verifyPayment, settlePayment, createProvider, createPaymasterConfig } from 'x402-starknet';

const app = express();
app.use(express.json());

const RPC = process.env.STARKNET_RPC_URL ?? 'https://starknet-sepolia.public.blastapi.io';
const NETWORK = process.env.PAYMASTER_NETWORK ?? 'starknet:sepolia';
const PAYMASTER_API_KEY = process.env.PAYMASTER_API_KEY; // AVNU (accès testnet sur demande)

const provider = createProvider(RPC);
const paymasterConfig = createPaymasterConfig(NETWORK, { apiKey: PAYMASTER_API_KEY });

app.post('/verify', async (req, res) => {
  try {
    const { payload, requirements } = req.body ?? {};
    const result = await verifyPayment(provider, payload, requirements);
    res.json({ valid: result.isValid ?? result.valid, payer: result.payer, reason: result.reason });
  } catch (e: any) {
    res.status(200).json({ valid: false, reason: `verify_error:${e?.message ?? 'unknown'}` });
  }
});

app.post('/settle', async (req, res) => {
  try {
    const { payload, requirements } = req.body ?? {};
    const result = await settlePayment(provider, payload, requirements, { paymasterConfig });
    res.json({ success: result.success ?? true, txHash: result.txHash ?? result.transaction });
  } catch (e: any) {
    res.status(200).json({ success: false, reason: `settle_error:${e?.message ?? 'unknown'}` });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, network: NETWORK }));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`[x402-facilitator] listening on :${port} (${NETWORK})`));
