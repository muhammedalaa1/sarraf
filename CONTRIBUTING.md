# Contributing to Sarraf

Thanks for helping. Sarraf moves money, so the bar is correctness first.

## Setup

```bash
corepack enable   # or: npm i -g pnpm@12
pnpm install      # also installs the git hooks (lefthook)
pnpm build
pnpm check        # lint, typecheck, tests, package checks, secret scan: the same as CI
```

- Node 22.12+ for development (published packages support 22+) · pnpm workspaces · Turborepo · TypeScript (strictest settings) · tsup · Vitest · Biome · ESLint (type-aware) · Changesets
- Every PR that touches a published package needs a changeset: `pnpm changeset`.
- Never commit credentials. `pnpm check-secrets` runs on every commit and in CI, and also checks every value in your local `.env.sandbox`.
- The README has a full table of the guardrails and how to satisfy each one: [Guardrails](./README.md#guardrails-what-ci-enforces-and-why).

## House style (the guardrails enforce most of this)

- **Optional fields are `field?: T | undefined`**, not `field?: T`. This works for consumers whether or not they enable `exactOptionalPropertyTypes`.
- **No `any`, no `!` non-null assertions, no `@ts-ignore`** in published code. Parse unknown JSON with `asRecord()` / `str()` from core. `str()` returns `undefined` for objects, so nothing is ever signed as `"[object Object]"`.
- **Lookups:** use `requireLookupKey(lookup, "<provider>")` instead of `lookup.reference!`.
- **Logging:** use the injected `ctx.logger`, never `console`. Never log a value that hasn't been through `redact()`.
- **Money:** integers in minor units only. Format for a provider with `toMajorString` / `toMajorFixed` / `normalizeDecimal`, never `toFixed` or float division.
- **Money-moving HTTP calls** set `moneyMoving: true` and must never be retried automatically.
- **Exported functions declare their return types.**
- **Public API changes** show up in `test/public-api.test.ts` snapshots. Update them deliberately (`pnpm vitest run -u`) and choose the right semver bump.

## Repository layout

```text
packages/core      client, models, money, errors, http, idempotency, webhook router, conformance suite
packages/<name>    one adapter per provider
packages/testing   fake provider, mock fetch, fixture loader
packages/express   framework helpers
apps/dashboard     sandbox playground + webhook inbox
apps/docs          documentation site
examples/          runnable shops
fixtures/          scrubbed sandbox payloads: fixtures/<provider>/<scenario>.json
scripts/           record-fixtures, scrub, check-no-secrets
```

## How to add a provider

Use `packages/paymob` as the reference adapter. Checklist:

1. **Package**: `packages/<name>` with `package.json` (`@sarraf/<name>`), `tsup.config.ts` (entries `index` + `testing`), `vitest.config.ts`.
2. **Register the id**: in the adapter, augment the core registries:
   ```ts
   declare module "@sarraf/core" {
     interface ProviderRegistry { tap: true }
     interface ProviderOptionsRegistry { tap: TapProviderOptions }
   }
   ```
3. **Follow the layer split** (pure functions where it matters):
   - `config.ts`: zod-validated options, base URLs per region/environment
   - `client.ts`: thin typed endpoint wrappers. Set `moneyMoving: true` on create/refund/void.
   - `signature.ts`: **all** hashing, pure, no I/O, one function per signature type
   - `mappers.ts`: provider objects ⇄ Sarraf models, plus an exported `<NAME>_STATUS_TABLE`
   - `webhooks.ts`: `inspect` / `verify` / `parse`
   - `adapter.ts`: implements `PaymentProvider`
   - `testing.ts`: helpers that build signed webhooks for tests
4. **Capabilities**: declare honestly. Anything not confirmed against a real sandbox call is `"beta"`.
5. **Fixtures**: add known-good signature fixtures under `fixtures/<name>/`. Generate the expected signature *independently* of your implementation (see how the existing fixtures were built), then record real ones with `pnpm record-fixtures`.
6. **Tests** (coverage ≥ 95% on `signature.ts` and `mappers.ts`, enforced by thresholds in `vitest.config.ts`):
   - every signature function against its fixture
   - tamper cases: changed amount, changed status, wrong key, missing signature, extra whitespace
   - one test per status-table row
   - `runConformanceTests()` from `@sarraf/core/conformance`
   - `test/public-api.test.ts` (copy it from `packages/paymob`) so the export surface is snapshotted
7. **Sandbox contract test** in `tests/sandbox/contract.test.ts`, skipped when credentials are missing.
8. **Docs**: a provider page in `apps/docs` covering setup, credentials, flows, the status table, gotchas and signature recipes.
9. **Not affiliated**: no provider logos or branding.

## Verifying a ⚠️ item

When a sandbox call confirms something marked ⚠️ in an adapter:

1. Record it: `pnpm record-fixtures …` and commit the scrubbed fixture.
2. Add or adjust the test that locks it in.
3. Change the capability from `"beta"` to `"supported"` (if relevant) and flip `verified: true` in the status table.
4. Update the provider docs page.

## Commit / PR style

- Small, focused PRs, with tests in the same PR.
- Conventional-ish commit subjects (`fix(paymob): …`, `feat(core): …`).
- Fill in the PR template, including how you verified the change.
