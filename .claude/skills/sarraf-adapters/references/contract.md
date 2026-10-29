# The adapter contract (packages/core)

## PaymentProvider

```ts
interface PaymentProvider<Id extends ProviderId> {
  readonly id: Id;
  readonly capabilities: Capabilities;
  attach?(ctx: Ctx): void;                       // called once by new Sarraf(); for extras APIs
  createCheckout(input: CreateCheckoutInput<Id>, ctx): Promise<Checkout>;
  getPayment(lookup: PaymentLookup, ctx): Promise<Payment>;
  refund?(input: RefundInput, ctx): Promise<Refund>;
  cancel?(lookup: PaymentLookup, ctx): Promise<Payment>;   // same-day void / cancel unpaid code
  capture?(input: CaptureInput, ctx): Promise<Payment>;
  inspectWebhook(req, ctx): Promise<WebhookInspection>;    // never throws
  verifyWebhook(req, ctx): Promise<VerifiedWebhook>;       // throws WEBHOOK_SIGNATURE_INVALID
  parseWebhook(verified, ctx): Promise<SarrafEvent>;
  verifyRedirect?(query, ctx): Promise<RedirectResult>;
}
```

`Ctx = { http, logger, now(), idempotency }`. Adapters must use `ctx.http` (redaction, retries,
logging) and `ctx.now()` (testable time), never global `fetch` / `Date.now()`.

Provider ids are registered through module augmentation of `ProviderRegistry`; typed
`providerOptions` through `ProviderOptionsRegistry` (see the `declare module "@sarrafjs/core"` block
in each adapter).

## Capabilities

```ts
type CapabilityLevel = "supported" | "beta" | "unsupported";
interface Capabilities {
  checkout; getPayment; refund; partialRefund; cancel; capture; webhooks; redirectVerification: CapabilityLevel;
  methods: Partial<Record<PaymentMethod, CapabilityLevel>>;   // card wallet cash_outlet installments bnpl bank_transfer other
  currencies: Currency[];
  checkoutKinds: ("redirect" | "reference_code")[];
  docsUrl: string;
}
```

The facade enforces them: `require(provider, key)` before calling, `partialRefund` when `amount`
is passed, each requested method's level, and currency membership.

## Shapes

- `Payment`: `id` (`<provider>_<providerPaymentId>`), `providerPaymentId`, `reference` (merchant
  order id), `status`, `amount`, `amountRefunded`, `method?`, `card?{last4,brand}`,
  `failure?{code,message,providerCode}`, `createdAt?`, `raw`.
- `PaymentStatus`: `pending | requires_action | awaiting_payment | succeeded | failed | canceled |
  expired | refunded | partially_refunded`. `requires_action` also means "authorized, needs capture".
- `Checkout`: `{ id, provider, kind, redirectUrl?, referenceCode?, expiresAt?, payment, raw }`.
- `Refund`: `{ status: pending|succeeded|failed, providerRefundId?, amount?, payment? }`.
- `SarrafEvent = PaymentEvent | CardSavedEvent`. Only `card.saved` lacks `payment`; callers narrow on
  `type`. `buildEvent` builds a `PaymentEvent`; `refund.*` types must be set explicitly for refund
  callbacks.

## Facade behaviour (sarraf.ts)

- `checkout.create`, `refunds.create`, `payments.capture` go through `runIdempotent` when an
  `idempotencyKey` is given (fingerprint check; lock kept after `TIMEOUT_UNKNOWN_OUTCOME`).
- `payments.reconcile` is `payments.get`.
- `webhooks.verifyAndParse` = `verifyWebhook` → `parseWebhook`; `webhooks.inspect` never throws.

## Conformance suite (core/src/conformance.ts)

Every adapter's test file calls `runConformanceTests(name, setup)` with a harness: a `Sarraf` on a
mock fetch, a checkout input, signed `succeeded` / `tampered` / optional `refunded` webhooks, a
lookup that answers paid, optional `refund` and `capture` inputs. It checks: capability set,
checkout shape (status pending/awaiting_payment/requires_action), idempotent replay, webhook
normalization + dedupe id, tamper rejection, inspection, getPayment, refund + refund webhook,
capture (or `capture: "unsupported"` when no capture input).

## Fixtures and recording

- `fixtures/<provider>/sandbox-*.json` are real, scrubbed, re-signed with the throwaway secrets in
  `TEST_SECRETS` (`scripts/record-fixtures.ts`). Others are synthetic and say so in `source`.
- Record: fill `.env.sandbox` (copy `.env.sandbox.example`, test keys only — `assertSandbox` refuses
  live keys), then `pnpm record-fixtures <checkout|status|refund|cancel|capture|charge|link|webhook> …`.
  `webhook` listens on :4545; expose it with `cloudflared tunnel --url http://localhost:4545` and set
  `SANDBOX_PUBLIC_URL`. Auto-numbered `sandbox-webhook-<status>-<n>.json` files are gitignored;
  rename one to a scenario name to keep it.
- Contract tests against real sandboxes: `pnpm test:sandbox` (`tests/sandbox/contract.test.ts`),
  skipped per provider when credentials are missing.

## New adapter checklist

1. `packages/<id>/src/{config,client,mappers,signature,webhooks,adapter,testing,index}.ts` — copy the
   Kashier layout. zod options schema; `resolveConfig` throws `CONFIGURATION_INVALID`.
2. Register the id (`ProviderRegistry`) and options (`ProviderOptionsRegistry`).
3. Capabilities: everything unverified is `"beta"`.
4. Status table with `verified` flags; signature functions with an exported "signed string" helper
   so `inspectWebhook` can show it.
5. `testing.ts`: realistic payload builders and signers for tests and the dashboard.
6. Tests: conformance + unit + signature tests; public-api snapshot.
7. Wire into `scripts/providers.ts`, `scripts/record-fixtures.ts` (`resign`), `apps/dashboard/lib/sarraf.ts`,
   `.env.sandbox.example`, docs page, README support table, a changeset, and a provider skill.
