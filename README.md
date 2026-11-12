# x402 on Starknet

[![CI](https://github.com/vadum-lab/x402-starknet/actions/workflows/ci.yml/badge.svg)](https://github.com/vadum-lab/x402-starknet/actions/workflows/ci.yml)

An open-source **[x402](https://github.com/coinbase/x402) (HTTP 402) payment facilitator for Starknet**,
plus a demo client. It lets any HTTP service charge **per-request, on-chain payments** on Starknet,
using **account abstraction (SNIP-9 Outside Execution)** so the payer signs off-chain and never
touches gas.

> **Conforms to the registered x402 `exact` scheme on Starknet**, pinned at commit
> [`d6d2c580`](https://github.com/x402-foundation/x402/blob/d6d2c580142eec4ff96935ad834009454253d9a3/specs/schemes/exact/scheme_exact_starknet.md)
> of `x402-foundation/x402` (file blob `4d778150`). Later upstream changes are read, not adopted automatically.
>
> ⚠️ **Not yet run on Sepolia in this format.** The earlier on-chain proof
> ([`0x541e54e0…4db4824`](https://sepolia.starkscan.co/tx/0x541e54e0dffcbd5d0935eaabd3bc7364602c7984506a795b9dae390a4db4824))
> was produced by the **pre-scheme** format, which this version replaces. The tests run the real services against
> fakes (no network); the SNIP-12 domain hash, the simulation and the receipt checks have not been exercised on chain.
>
> **Breaking change**, no compatibility mode: payload, routes, network ids and response fields all changed
> (see [Migrating](#migrating-from-the-pre-scheme-format)).
>
> Extracted from the [Vadum Lab](https://vadum-lab.com) **Mycelium** project as a reusable component.
> Testnet (Sepolia) reference implementation — production custody/security is out of scope.

## How it works

```
  Paying agent (client)                     Your service                     Facilitator (this repo)
        │  request a paid resource              │                                  │
        │ ────────────────────────────────────►│  ── GET /supported ─────────────►│  feePayer (the executor)
        │ ◄─ 402 + PAYMENT-REQUIRED ────────────│  (asset, payTo, amount, feePayer)│
        │  sign SNIP-9 Outside Execution,       │                                  │
        │  Caller = feePayer                    │                                  │
        │  replay + PAYMENT-SIGNATURE header ──►│  ── POST /verify ───────────────►│  9 rules: typed data, SNIP-6
        │                                       │                                  │  signature, nonce, window,
        │                                       │  ── POST /settle ───────────────►│  one transfer, balance, simulation
        │                                       │                                  │  → execute_from_outside_v2
        │ ◄─ 200 + PAYMENT-RESPONSE ────────────│  ◄── success, transaction ───────│  (facilitator pays gas)
```

- **x402 v2 over HTTP** — `PAYMENT-REQUIRED` (402), `PAYMENT-SIGNATURE` (request), `PAYMENT-RESPONSE`
  (settlement), all base64 JSON.
- **SNIP-9 Outside Execution** — the payer signs a SNIP-12 typed message authorizing one token `transfer` to
  `payTo`; the facilitator submits it. The signed `Caller` is the facilitator's `feePayer`, so **only the
  facilitator can execute it** (`ANY_CALLER` is refused).
- **Fail closed.** An RPC failure never produces a payment-state verdict: `/verify` answers
  `unexpected_verify_error`, `/settle` answers `unexpected_settle_error`.

### Facilitator API

| Route | Answer |
|---|---|
| `GET /supported` | `{kinds: [{x402Version: 2, scheme: "exact", network, extra: {feePayer}}], extensions, signers}` |
| `POST /verify` `{x402Version, paymentPayload, paymentRequirements}` | `{isValid, invalidReason?, payer?}` |
| `POST /settle` same body | `{success, transaction, network, payer?, errorReason?}` |
| `GET /health` | local route, outside the scheme |

Networks use CAIP-2: `starknet:SN_SEPOLIA`, `starknet:SN_MAIN`. `payer` is only returned once its signature was
verified. `invalidReason` / `errorReason` are stable tokens of the scheme (`invalid_exact_starknet_payload_signature`,
`nonce_already_used`, `simulation_failed`, …), never raw RPC text.

**`/settle`** re-runs every check (a prior `/verify` is not trusted), submits, waits for `ACCEPTED_ON_L2`/`L1` with a
block number, and reports `success: true` only if the transaction `SUCCEEDED` **and** its receipt shows exactly one
`Transfer` from the payer to `payTo` for the exact amount. Otherwise:

- **reverted** → `invalid_transaction_state` with the hash; the revert rolled the SNIP-9 nonce back, so the same
  payment may be retried;
- **no outcome yet** → `settlement_pending` (non-terminal, carries the hash, **never re-broadcast**); a retry of the
  same payload waits on that hash;
- any other repeat of the same `(payer, Nonce)` → `duplicate_settlement`.

The duplicate cache is in-process: **a restart loses it**, so a retry just after a restart could re-broadcast
(accepted for testnet; durable storage is required before mainnet). A lost `/settle` response after a success also
answers `duplicate_settlement` on retry, with `success: false`, for a payment that happened: reconcile the
transaction on chain. `X402_SETTLE_WAIT_MS` (default 60 s) bounds the wait.

## Settlement modes

|                 | **Self-submit** (default, conforming)            | **AVNU** (paymaster) — *not migrated*    |
|-----------------|--------------------------------------------------|------------------------------------------|
| Who pays gas    | the **facilitator** (`execute_from_outside_v2`)  | the **AVNU** paymaster                   |
| Format          | registered `exact` scheme                        | pre-scheme format, untested              |
| Entry point     | `npm start` → `selfsubmit.ts`                    | `npm run start:avnu` → `index.ts`        |

`facilitator/index.ts` and `demo-client/index.ts` (AVNU) still speak the pre-scheme format and are neither
type-checked nor tested by CI. Their future is undecided.

## Layout

```
facilitator/     Node/TypeScript sidecar — GET /supported, POST /verify, POST /settle, GET /health
                 (scheme.ts rules · verify.ts · settle.ts · chain.ts RPC · transfers.ts)
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

The client's first request gets a **402** with the price and the sponsor's `feePayer`; it checks, then signs, a SNIP-9
authorization with `Caller = feePayer`, and replays with a `PAYMENT-SIGNATURE` header. The server relays it to the
facilitator (`/verify` then `/settle`); once settled on-chain, the resource is served with a `PAYMENT-RESPONSE`
header carrying the transaction hash. If the answer is `settlement_pending`, **reconcile that transaction on chain
before paying again**.

### The example server

`server/server.ts` holds **no keys**: it reads the sponsor's `feePayer` from the facilitator's `/supported`, answers
`402` with the price, and on a `PAYMENT-SIGNATURE` header calls the facilitator's `/verify` + `/settle`, then serves
the resource. It builds the requirements itself and never takes them from the client. Point it at your own logic by
editing the `resource()` function. Config: `FACILITATOR_URL`, `X402_PAY_TO`, `X402_ASSET`, `X402_NETWORK`,
`X402_AMOUNT` (price in atomic units), `X402_MAX_TIMEOUT_SECONDS`. HTTP status: 400 malformed payment, 402 payment
refused or pending, 500 unexpected facilitator error, 502 facilitator unreachable.

## Tests

`cd facilitator && npm install && npm test` (and the same in `server/` and `demo-client/`). The tests run the real
services against fake Starknet nodes and a fake facilitator on localhost, with no network and no real keys. CI runs
the `facilitator` and `server` tests; `demo-client` tests are run by hand for now.

## Notes

- The resource server must build the `paymentRequirements` itself, never accept them from the client; `/verify`
  checks the client's `accepted` against them field by field, and requires the exact amount.
- `feePayer` is the facilitator's executor account (`FACILITATOR_ADDRESS`), announced at `/supported`. A client
  that signed against a retired `feePayer` is refused: there is no rotation grace window yet.
- `X402_ASSET` / `X402_PAY_TO` on the facilitator are an optional allow-list: when set, other assets and recipients
  are refused with `invalid_payment_requirements`.
- All state reads and the simulation use the `latest` (accepted) block; the freshness rule accepts a payload only
  within 60 s of signing, and a settlement needs at least 30 s of validity left.
- **`starknet.js` is pinned to `10.6.8`** in all `package.json` files. v10 uses object-form
  constructors (`new Account({ provider, address, signer })`); mixing v6/v10 breaks `new Account`.
- **Node ≥ 22** (required by starknet.js v10) — the Docker image uses `node:22-alpine`.
- Address comparisons use **BigInt** (a felt ignores leading zeros).
- Assets are configurable (`X402_ASSET`): STRK (18 decimals) by default, USDC (6) optionally.
- The **pricing/economy** lives in the *consuming* service, not here — this repo is the payment rail only.

## Migrating from the pre-scheme format

| Before | Now |
|---|---|
| payload `{authorization, outsideTransaction}` | `{from, outsideExecution: {typedData, signature}}` inside a v2 `PaymentPayload` |
| `POST /verify {payload, requirements}` → `{valid, reason}` | `{x402Version, paymentPayload, paymentRequirements}` → `{isValid, invalidReason}` |
| `POST /settle` → `{success, txHash, reason}` | `{success, transaction, network, payer?, errorReason?}` |
| network `starknet:sepolia` | `starknet:SN_SEPOLIA` |
| `caller: ANY_CALLER` | `Caller = extra.feePayer` from `GET /supported` |
| 402 body only | `PAYMENT-REQUIRED` header; settlement in `PAYMENT-RESPONSE` |
| resource field `reglement_tx` | `transaction` |

## License

MIT © 2026 Vadum Lab
