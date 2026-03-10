# Oracle - Private Prediction Market (Solana x Arcium)

Oracle is a privacy-focused prediction market prototype where market positions are submitted as encrypted payloads and resolved through a dispute-aware settlement flow.

## Current Status

- Frontend + backend prototype is working.
- Security-oriented dispute flow is implemented (invalid market path, challenge windows, slashing records).
- Backend test matrix is implemented and passing (unit + integration + adversarial).

## Core Features

- Encrypted position submission flow (client-side encrypted payloads)
- Market categories (Crypto, Football, Politics, Macro, Tech)
- Market activity + append-only audit log via indexer service
- Dispute engine with:
  - Challenge window deadlines
  - Invalid market resolution metadata
  - Resolver slashing records
- Wallet unlock guard before privileged actions (create market, submit position, dispute actions)

## APIs In Use

- Solana RPC endpoint
  - Config: `NEXT_PUBLIC_SOLANA_RPC`
  - Fallback: `https://api.devnet.solana.com`
- News API aggregator endpoint (`/api/news/headlines`)
  - Providers supported: `gnews`, `newsapi`
  - Config: `NEWS_API_PROVIDER`, `NEWS_API_KEY`
  - Fallback mode returns static headlines when no API key is set
- Arcium cluster key fetch (currently mocked in code)
  - `fetchClusterPublicKey()` currently returns placeholder bytes in `utils/arcium.ts`

## Information Verification Model (Recommended)

For production settlement integrity, enforce:

1. Multi-source verification: query at least 2 independent sources per market.
2. Canonical hashing: store `source_payload_hash + timestamp + source_id` in audit log before resolution.
3. Source allowlist: accept only approved official sources per category.
4. Dispute evidence binding: require evidence URI + hash in dispute resolution records.

## Backend Security Audit (March 7, 2026)

### Standard Checks Executed

- Dependency vulnerability scan: `npm audit --omit=dev --audit-level=moderate`
- Type safety pass: `npx tsc --noEmit`
- Backend test matrix: `npm run test:matrix`
- Secret pattern scan (repo): no matches found
- Dangerous API scan (`eval`, dynamic function execution, shell exec patterns): no matches found in app source

### Test Results

- `test:unit`: pass (3/3)
- `test:integration`: pass (2/2)
- `test:adversarial`: pass (3/3)
- Type check: pass

### Vulnerability Findings

- `npm audit` reports **1 critical vulnerability** in `next` (current pinned line includes affected versions).
- Suggested fix from audit: upgrade to patched Next release (e.g., `14.2.35` or later in the 14.x line).

### Cybersecurity Rating

Current backend security rating: **68 / 100**

Rationale:

- Strong points:
  - Challenge/slashing dispute controls
  - Invalid market path with metadata
  - Passing adversarial tests
  - No obvious hardcoded secrets or dangerous runtime APIs in backend source
- Score reducers:
  - Critical dependency finding in `next`
  - Arcium key retrieval is still mocked (not a production trust path)
  - No automated CI gating yet for `npm audit`/SAST/secret scan

## Immediate Remediation Priorities

1. Upgrade `next` to a patched non-vulnerable release and re-run `npm audit`.
2. Replace mocked Arcium key fetch with authenticated cluster key retrieval + signature verification.
3. Add CI security gates:
   - `npm audit --audit-level=high`
   - secret scan
   - static analysis
   - required pass for `test:matrix`

## Useful Commands

```bash
npm run dev
npm run build
npm run test:matrix
npm run audit:backend
npx tsc --noEmit
```

## License

MIT
