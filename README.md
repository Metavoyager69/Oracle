# Oracle - Private Prediction Market (Solana x Arcium)

Oracle is an open-source privacy-focused prediction market prototype built with:
- a Solana Anchor program
- a Next.js frontend/backend
- Arcium-powered client-side encryption for private position flow

The core idea is simple: public prediction markets are good at aggregating information, but they also leak information too early. When stake sizes, sentiment, and early positioning are visible in real time, traders can herd, copy, manipulate, or withhold honest signals. Oracle explores a different model where stake, vote direction, and reveal inputs remain encrypted until settlement-oriented workflows decide what can be revealed.

## Why This Project Exists

Traditional prediction and opinion markets often expose:
- who is participating
- which side they are taking
- how much size is backing that side
- crowd momentum before resolution

That can distort honest participation. Oracle uses Arcium so that:
- stake size can stay private
- choice direction can stay private
- early crowd signals are harder to exploit
- settlement can still happen through controlled reveal workflows

## How Arcium Is Used

Arcium is used on the client-side position flow, not as a vague "privacy layer" label.

Current flow in this repo:
1. The frontend encrypts stake size and position side locally with Arcium utilities in `utils/arcium.ts`.
2. The app sends ciphertext plus a commitment hash instead of plaintext betting data.
3. The nonce used to blind the stake commitment stays client-side in an encrypted browser vault in `utils/nonce-vault.ts`.
4. The backend store and APIs work with encrypted payloads, redacted history, and settlement-oriented records.
5. The relay/reveal path builds a deterministic reveal message so aggregated totals can be recorded without exposing every individual position.

## Privacy Benefits

- Plaintext stake and side do not need to travel through normal API payloads.
- Other traders do not get a live public odds feed sourced from everyone's visible position data.
- Wallet-scoped position history can stay private instead of being globally queryable.
- The design reduces herding pressure and "follow the whale" behavior common in public markets.

## Architecture Overview

### Frontend

- `pages/` contains the user flows for discovery, creation, portfolio, and market participation.
- `pages/_app.tsx` wires wallet providers and the Solana RPC endpoint.
- `pages/markets/index.tsx` and `pages/portfolio.tsx` already consume backend APIs.
- `pages/create/index.tsx` can create a real on-chain market first, then mirror the confirmed metadata into the backend when a token mint is configured.
- `pages/market/[id].tsx` loads backend-backed market data and uses a real on-chain `submit_position` flow for chain-backed markets, while older backend-only markets still fall back to the prototype mirror path.

### Backend

- `pages/api/` exposes market, position, dispute, audit, portfolio, and relay routes.
- `lib/server/api-guards.ts` handles wallet auth, replay protection, rate limiting, and admin checks.
- `lib/server/store.ts` persists market, position, dispute, and audit data using sqlite or file snapshots.
- `lib/server/services/` contains the dispute engine and indexer/audit helpers.

### Solana Program

- The Anchor program lives in `programs/prediction-market/src/lib.rs`.
- `Anchor.toml` is currently configured for `devnet`.
- The program defines registry, market, position, challenge, and settlement-oriented account/state structures.

### Arcium / Encryption Layer

- `utils/arcium.ts` contains client-side encryption helpers and commitment generation.
- `utils/nonce-vault.ts` stores stake nonces locally in an encrypted browser vault.
- The project uses Arcium to prepare private submission payloads before they touch normal app/network boundaries.

## Current Status

This project should be described honestly as:

`A Devnet prototype of a private Solana prediction market with Arcium-based encrypted position flow.`

What is already real in this repo:
- a real Anchor program
- a real Next.js app and API surface
- real wallet-signature auth for sensitive reads/writes
- real encrypted client payload generation
- real chain-backed market creation when `NEXT_PUBLIC_MARKET_TOKEN_MINT` is configured
- real chain-backed position submission for markets that exist on-chain
- real local persistence, dispute tracking, audit history, and rate limiting

What is still prototype or mocked:
- backend mirroring is still required for the app to discover and render chain-created markets
- the backend store is still the immediate source of truth for some flows that a stronger production design would mirror from confirmed on-chain state
- the relay endpoint still needs a stronger production trust/proof model

## Quick Start

### App

```bash
npm install
copy .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

### Optional Build / Test Checks

```bash
npm run build
npm run test:matrix
npm run audit:backend
```

### Anchor Program

If you want to inspect or build the Solana program, this repo also includes an Anchor workspace:

```bash
anchor build
```

`Anchor.toml` is currently pointed at `devnet`.

## Configuration

The most important env vars in this repo today are:

### Frontend / Next.js

- `NEXT_PUBLIC_SOLANA_RPC`
- `NEXT_PUBLIC_PREDICTION_MARKET_PROGRAM_ID`
- `NEXT_PUBLIC_MARKET_TOKEN_MINT`
- `NEXT_PUBLIC_MARKET_TOKEN_SYMBOL`
- `NEXT_PUBLIC_MARKET_TOKEN_DECIMALS`

### Backend Persistence / Auth

- `ORACLE_STORE_BACKEND`
- `ORACLE_DB_PATH`
- `ORACLE_STORE_PATH`
- `ORACLE_ADMIN_WALLET`
- `ORACLE_ADMIN_KEYPAIR_PATH`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

### Optional Feeds / Integrations

- `NEWS_API_PROVIDER`
- `NEWS_API_KEY`
- `LINEAR_API_KEY`

### Optional Indexer Worker

- `SOLANA_RPC_URL`
- `PREDICTION_MARKET_PROGRAM_ID`
- `INDEXER_POLL_MS`
- `INDEXER_LIMIT`

## Demo Flow

This is the cleanest hackathon demo path for the current repo:

1. Start the app and connect Phantom or Solflare.
2. Open `/markets` to show backend-fed market discovery.
3. Open `/create` and explain how market metadata, rules, and wallet auth are captured.
4. Open one market and explain the private-position flow:
   - stake and side are encrypted client-side
   - plaintext is not what the app sends through the normal submission path
   - chain-backed markets commit stake on Solana before the backend mirrors the encrypted record
   - commitment + nonce model supports later reveal flow
5. Open `/portfolio` and explain that history is wallet-scoped and redacted for encrypted positions.
6. Explain the dispute/audit/relay architecture as the settlement-side control plane.

## Security-Critical Mechanics

- Client-side encrypted stake/choice with a commitment hash.
- Wallet-signature auth with timestamp and nonce replay protection.
- Redis-backed rate limiting and nonce storage in production.
- Settlement challenge window with dispute evidence support.
- Append-only audit-style event history and integrity-chain checks.

## Known Limitations

- Prototype only. Not audited for production use.
- Chain-backed create/submit requires an initialized registry, a configured token mint, and a funded wallet token account for staking.
- Older backend-only markets still use the prototype submission path rather than the real on-chain `submit_position` instruction.
- The relay endpoint needs stronger production-grade verification before mainnet use.
- The local store is excellent for prototyping, but a production/mainnet deployment should align state more tightly with confirmed on-chain events.

## Roadmap To Stronger Production / Mainnet Readiness

- Expand chain-backed flows so market discovery and portfolio views can be rebuilt from confirmed on-chain/indexed state alone.
- Strengthen relay authentication/proof verification.
- Keep wallet-scoped history private across all detail views.
- Run a deeper security review of wallet auth, replay protection, and settlement flows.

## Commands

```bash
npm run dev
npm run build
npm run test:matrix
npm run audit:backend
npm run indexer:worker
```

## License

MIT
