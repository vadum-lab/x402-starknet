# x402 on Starknet

An open-source **[x402](https://github.com/coinbase/x402) (HTTP 402) payment facilitator for Starknet**,
plus a demo client. It lets any HTTP service charge **per-request, on-chain payments** on Starknet,
using **account abstraction (SNIP-9 Outside Execution)** so the payer signs off-chain and never
touches gas.

> **Validated live on Starknet Sepolia.** Full cycle settled on-chain — proof tx
> [`0x6bc19443…a901f`](https://sepolia.starkscan.co/tx/0x6bc19443c6df905e07a4c80c9ce905d6ab9ac43b48289cc67943f84cc5a901f).
>
> Extracted from the [Vadum Lab](https://vadum-lab.com) **Mycelium** project as a reusable component.
> Testnet (Sepolia) reference implementation — production custody/security is out of scope.

## How it works

```
  Paying agent (client)                     Your service                     Facilitator (this repo)
        │  request a paid resource              │                                  │
        │ ────────────────────────────────────►│                                  │
        │ ◄──── 402 + PaymentRequirements ──────│  (asset, payTo, amount)          │
        │  sign SNIP-9 Outside Execution        │                                  │
        │  replay + PAYMENT-SIGNATURE header ──►│  ── /verify ────────────────────►│  isValidSignature (SNIP-6),
        │                                       │  ── /settle ────────────────────►│  balance, replay nonce
        │                                       │                                  │  → executeFromOutside
        │ ◄──── 200 (resource served) ──────────│  ◄── settled (ACCEPTED_ON_L2) ───│  (facilitator pays gas)
```

- **x402 standard** (HTTP 402 "Payment Required") — the server answers `402` with payment terms; the
  client pays; the resource is served (~2 s).
- **SNIP-9 Outside Execution** — the payer signs a meta-transaction authorizing a token `transfer`
  to `payTo`; the facilitator submits it.
- **Two settlement modes** (below): **self-submit** (default, no third-party dependency) and **AVNU**
  paymaster (lib-native, gasless payer).

## Two settlement modes

|                 | **Self-submit** (default)                        | **AVNU** (paymaster)                     |
|-----------------|--------------------------------------------------|------------------------------------------|
| Who pays gas    | the **facilitator** (`executeFromOutside`)       | the **AVNU** paymaster (payer gasless)   |
| External dep.   | none — just funded testnet accounts              | AVNU Sepolia key (on request)            |
| Entry point     | `npm start` → `selfsubmit.ts`                    | `npm run start:avnu` → `index.ts`        |

## Layout

```
facilitator/     Node/TypeScript sidecar — POST /verify + POST /settle, GET /health
demo-client/     TypeScript — receives 402, signs SNIP-9, replays with the payment header
docker-compose.yml
.env.example
```

## Quick start (Sepolia testnet)

**Prerequisites** — self-serve, nothing gated:
1. A **Starknet Sepolia RPC** (e.g. Alchemy free tier) → `STARKNET_RPC_URL`.
2. A **funded facilitator account** (STRK for gas) → `FACILITATOR_ADDRESS` / `FACILITATOR_PRIVATE_KEY`.
3. A **payer account** funded with the asset (STRK) → `PAYER_ADDRESS` / `PAYER_PRIVATE_KEY`.
4. A **payTo** address that receives payments → `X402_PAY_TO`.

   Faucet: [faucet.starknet.io](https://faucet.starknet.io) (STRK covers both gas and the asset).
   USDC option: asset `0x0512feAc…`, [faucet.circle.com](https://faucet.circle.com), 6 decimals.

```bash
cp .env.example .env && $EDITOR .env

# run the facilitator
docker compose up -d --build
curl -s http://127.0.0.1:3402/health

# run the demo client (point X402_ENDPOINT at any x402-speaking server)
cd demo-client && npm install && npm start
```

## Notes

- **`starknet.js` is pinned to `10.6.8`** in both `package.json` files. v10 uses object-form
  constructors (`new Account({ provider, address, signer })`); mixing v6/v10 breaks `new Account`.
- **Node ≥ 22** (required by starknet.js v10) — the Docker image uses `node:22-alpine`.
- Address comparisons in `/verify` use **BigInt** (a felt ignores leading zeros).
- Assets are configurable (`X402_ASSET` + decimals): STRK (18) by default, USDC (6) optionally.
- The **pricing/economy** (how a paid request is priced, any token accounting) lives in the
  *consuming* service, not here — this repo is the payment rail only.

## License

MIT © 2026 Vadum Lab
