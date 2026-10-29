---
name: sarraf-adapters
description: The shared provider contract of the Sarraf payments SDK (packages/core) and how every adapter plugs into it — PaymentProvider, capabilities, statuses, events, idempotency, conformance suite, fixtures. Use this whenever you add or change anything in packages/core, add a new payment provider (Tap, HyperPay, Stripe…), touch Fawry, or change behaviour that more than one adapter shares (webhook routing, capture, refunds, error codes). The provider skills sarraf-paymob and sarraf-kashier build on this one.
---

# Sarraf adapter contract

Sarraf puts several payment providers behind one typed API. `packages/core` defines the contract;
each `packages/<provider>` implements it. The point of the SDK is that application code never has to
know which provider it is talking to, so every adapter must produce the *same shapes* with the *same
meaning*. When an adapter can't, it says so through capabilities instead of behaving differently.

## Map

| Path | What lives there |
|---|---|
| `packages/core/src/types.ts` | `PaymentProvider`, `Capabilities`, `Payment`, `PaymentStatus`, `SarrafEvent` (`PaymentEvent \| CardSavedEvent`), `CaptureInput`, `RefundInput` |
| `packages/core/src/sarraf.ts` | The `Sarraf` facade: capability checks, validation, idempotency, `provider(id)` (returns the concrete adapter type) |
| `packages/core/src/idempotency/run.ts` | `runIdempotent` — reuse it for any money-moving call outside the facade |
| `packages/core/src/http.ts` | `HttpClient`: `moneyMoving` (never retried; timeout → `TIMEOUT_UNKNOWN_OUTCOME`), `retryable`, redaction, FormData bodies, `ensureOk` |
| `packages/core/src/helpers.ts` | `sarrafId`, `buildEvent`, `eventTypeForStatus`, `refundedStatus`, `isPaymentEvent`, `assertPaymentEvent` |
| `packages/core/src/validation.ts` | zod schemas, `validateWith` for adapter inputs |
| `packages/core/src/webhook-utils.ts` | `normalizeHeaders/Query`, `parseJsonBody`, `getPath`, `str`, `asRecord` |
| `packages/core/src/conformance.ts` | `runConformanceTests` — every adapter must pass it |
| `packages/testing` | `createMockFetch` (records `json` and `form`), `fakeProvider`, fixture loading |
| `fixtures/<provider>/` | Recorded (`sandbox-*`) and synthetic fixtures |
| `scripts/record-fixtures.ts` | Records real sandbox exchanges, scrubs them, re-signs with test secrets |
| `apps/dashboard` | Sandbox UI: playground, operations (reconcile/capture/refund/void), webhook inbox, status explorer |
| `apps/docs/src/content/docs/providers/*.md` | Public provider guides |

Read `references/contract.md` for the exact types and the rules each method must follow.

## Rules that matter

- **Money is integer minor units** (`{ value: 25000, currency: "EGP" }` = 250.00). Convert to the
  provider's format only at the edge (Paymob cents, Kashier major-unit strings, Fawry 2-decimal).
- **Capability honesty.** `"supported"` means confirmed against the real sandbox with a recorded
  fixture. Unconfirmed features are `"beta"` (callers need `allowBeta: true`); impossible ones are
  `"unsupported"`. Server-side features that depend on an optional key (Paymob `apiKey`, Kashier
  `secretKey`) drop to `"unsupported"` without it.
- **Status tables are documentation.** Each adapter exports `<PROVIDER>_STATUS_TABLE`; a row is
  `verified: true` only with a fixture (put its path in `note`).
- **Webhooks are the source of truth; redirects are UX only.** Event ids are
  `"<provider>:<txnOrEventId>:<status>"` so retries dedupe.
- **Money-moving requests** (`createCheckout`, refund, void, capture, charges) use
  `moneyMoving: true`. Never add retries to them.
- **Errors** are `SarrafError` with a code from `errors.ts`; a provider refusing an operation is
  `PAYMENT_DECLINED`, a missing key is `CONFIGURATION_INVALID` with a message that says what to pass.
- **Public API changes are deliberate.** `test/__snapshots__/public-api.test.ts.snap` locks each
  package's exports; review the diff before `vitest -u`. Add a `.changeset/*.md` for user-visible changes.

## Workflow for a change

1. Read the provider skill (`sarraf-paymob`, `sarraf-kashier`) for provider facts. Don't guess
   endpoint shapes from memory; the references record what the sandbox actually returned.
2. Change the adapter; keep raw Paymob/Kashier shapes inside `client.ts` / `mappers.ts`.
3. Tests: unit tests with `createMockFetch`, plus the conformance suite. Use fixtures when they exist.
4. Run `pnpm typecheck`, `pnpm test`, `pnpm test:scripts`, `pnpm lint` (Biome + ESLint).
   On Windows Git Bash, heredocs collapse `\\` to `\` — write patch scripts to a file instead.
5. Update the provider's docs page, README, status table and the skill's references if behaviour changed.

## Adding a provider

Follow `references/contract.md` → "New adapter checklist".
