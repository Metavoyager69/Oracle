# Oracle — Private Prediction Market (Solana x Arcium)

Oracle is a privacy-focused prediction market prototype where positions are submitted as encrypted payloads and resolved through multi-oracle consensus with dispute controls.

## Security-Critical Mechanics
- Client-side encrypted stake/choice with a commitment hash; plaintext stakes are not sent to the API.
- Multi-oracle (3-of-5) voting with staking and slashing hooks.
- Settlement challenge window with a mandatory bond to prevent free griefing.
- Authority dispute resolution to uphold or cancel; refunds for cancelled/invalid markets.

## Status
Prototype only. Not audited for production use.
Arcium cluster public key fetch is currently mocked in `utils/arcium.ts`.

## Required Configuration
- `NEXT_PUBLIC_SOLANA_RPC`
- `NEXT_PUBLIC_ARCIUM_CLUSTER_ID`
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
