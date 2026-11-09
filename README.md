# x402 on Starknet

[![CI](https://github.com/vadum-lab/x402-starknet/actions/workflows/ci.yml/badge.svg)](https://github.com/vadum-lab/x402-starknet/actions/workflows/ci.yml)

An open-source **[x402](https://github.com/coinbase/x402) (HTTP 402) payment facilitator for Starknet**,
plus a demo client. It lets any HTTP service charge **per-request, on-chain payments** on Starknet,
using **account abstraction (SNIP-9 Outside Execution)** so the payer signs off-chain and never
touches gas.

> **Validated live on Starknet Sepolia** — the full loop in this repo (server → facilitator → client)
> settled on-chain: proof tx
> [`0x541e54e0…4db4824`](https://sepolia.starkscan.co/tx/0x541e54e0dffcbd5d0935eaabd3bc7364602c7984506a795b9dae390a4db4824)
> (`ACCEPTED_ON_L2` / `SUCCEEDED`), produced by the code here.
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
server/          minimal example server — gates a resource behind payment (emits 402, relays to the facilitator)
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

# start the facilitator + the example server
docker compose up -d --build
curl -s http://127.0.0.1:3402/health   # facilitator
curl -s http://127.0.0.1:8000/health   # example server

# run the demo client against the example server (full local loop)
cd demo-client && npm install && X402_ENDPOINT=http://localhost:8000/x402/hello npm start
```

The client's first request gets a **402** with the price; it signs a SNIP-9 authorization, replays with a
`PAYMENT-SIGNATURE` header, the server relays it to the facilitator (`/verify` then `/settle`), and — once
settled on-chain — the resource is served with the settlement `reglement_tx`.

### The example server

`server/server.ts` is ~60 lines and holds **no keys**: it answers `402` with the price, and on a
`PAYMENT-SIGNATURE` header it calls the facilitator's `/verify` + `/settle`, then serves the resource.
Point it at your own logic by editing the `resource()` function. Config: `FACILITATOR_URL`, `X402_PAY_TO`,
`X402_ASSET`, `X402_AMOUNT` (price in atomic units).

## Tests

`cd facilitator && npm install && npm test` (and the same in `server/`). The tests run the real services
against a fake Starknet RPC node and a fake facilitator on localhost, with no network and no real keys.

## Notes

- `/verify` checks the signed transfer against the **`requirements` sent by the resource server**, and
  requires the exact amount. A resource server must build these itself, never accept them from the client.
- `/settle` reports success only when the transaction's `execution_status` is `SUCCEEDED`. A transaction
  accepted on L2 but reverted answers `success: false`, with reason `invalid_transaction_state`.
- **`starknet.js` is pinned to `10.6.8`** in both `package.json` files. v10 uses object-form
  constructors (`new Account({ provider, address, signer })`); mixing v6/v10 breaks `new Account`.
- **Node ≥ 22** (required by starknet.js v10) — the Docker image uses `node:22-alpine`.
- Address comparisons in `/verify` use **BigInt** (a felt ignores leading zeros).
- Assets are configurable (`X402_ASSET` + decimals): STRK (18) by default, USDC (6) optionally.
- The **pricing/economy** (how a paid request is priced, any token accounting) lives in the
  *consuming* service, not here — this repo is the payment rail only.

## License

MIT © 2026 Vadum Lab
