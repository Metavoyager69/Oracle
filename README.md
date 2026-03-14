# Oracle - Private Prediction Market (Solana x Arcium)

Oracle is a privacy-focused prediction market prototype where positions are submitted as encrypted payloads and resolved through multi-oracle consensus with dispute controls.

## How Arcium Is Used
- The client encrypts the stake and position side locally using the Arcium cluster public key before any network call.
- Only ciphertext and commitment hashes are sent to the backend and written on-chain; no plaintext stake or choice is stored.
- At settlement time, Arcium MPC and threshold decryption produce the final outcome artifacts without exposing individual bets.

## Privacy Benefits
- Stake sizes and positions are never sent in plaintext or stored in logs.
- Activity feeds can remain aggregated or redacted to avoid leaking sensitive intent.
- Reduces data leakage and MEV-style inference around who took which side.

## Security-Critical Mechanics
- Client-side encrypted stake/choice with a commitment hash; plaintext stakes are not sent to the API.
- Multi-oracle (3-of-5) voting with staking and slashing hooks.
- Settlement challenge window with a mandatory bond to prevent free griefing.
- Authority dispute resolution to uphold or cancel; refunds for cancelled/invalid markets.

## Status
Prototype only. Not audited for production use.
Development uses a mock Arcium cluster key; production requires a real cluster key.

## Required Configuration
- `NEXT_PUBLIC_SOLANA_RPC`
- `NEXT_PUBLIC_PREDICTION_MARKET_PROGRAM_ID` (optional override)
- `NEXT_PUBLIC_ARCIUM_CLUSTER_ID`
- `NEXT_PUBLIC_ARCIUM_CLUSTER_PUBKEY` (required in production)
- `ORACLE_STORE_PATH` (required in production for persistence)
- `NEWS_API_PROVIDER`
- `NEWS_API_KEY`

## Commands
```bash
npm run dev
npm run build
npm run test:matrix
npm run audit:backend
```

## License
MIT
