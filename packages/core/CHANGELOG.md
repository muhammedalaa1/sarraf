# @sarrafjs/core

## 0.2.0

### Minor Changes

- ba96437: Paymob covers the rest of Paymob's collection API, and core gains capture and saved-card events.
  
  `@sarrafjs/core`:
  
  - **New:** `pay.payments.capture({ provider, providerPaymentId, amount? })` with a `capture` capability, validation and idempotency. Kashier and Fawry declare it `unsupported`.
  - **Breaking (types):** `SarrafEvent` is now `PaymentEvent | CardSavedEvent`. Narrow on `event.type` (or use `isPaymentEvent` / `assertPaymentEvent`) before reading `event.payment`. `EventOf<T>` gives the shape of one event type.
  - `pay.provider(id)` returns the concrete adapter type, so adapter-specific APIs are typed.
  - Adapters can implement `attach(ctx)` to get the `Sarraf` context. `runIdempotent` and `validateWith` are exported for adapters. The HTTP client sends `FormData` / `URLSearchParams` bodies as is.
  
  `@sarrafjs/paymob`:
  
  - **Fix:** checkout no longer reports Paymob's order id as `providerPaymentId`. It is empty until the transaction exists (webhook or reconcile), because refunds, voids and captures need the transaction id.
  - **Fix:** lookups send the auth token as a `Bearer` header (and in the body for the reference inquiry) and retry once with a fresh token after a 401.
  - **Fix:** a void Paymob does not accept throws `PAYMENT_DECLINED` instead of returning a failed payment. Voids work by `reference` too.
  - **Fix:** refund callbacks report the refunded payment with its totals (needs `apiKey`). `refund.payment` is set after a refund.
  - **Fix:** valU and other lenders map to `bnpl`; bank installments stay `installments`. `sarraf_ref` can no longer be overwritten by metadata.
  - **New (beta):** kiosk bill references (`methods: ["cash_outlet"]`, `kind: "reference_code"`), manual capture (`providerOptions.capture: "manual"` + `integrationIds.card_auth`), `card.saved` events from `TOKEN` callbacks, Apple Pay offered with card.
  - **New:** `pay.provider("paymob").extras`: saved-card charges (MOTO), card-token inquiry, subscriptions (plans, lifecycle, cards, callbacks), payment links, intention update / retrieve. `paymobEmbed(checkout)` for Pixel and `paymobIntegrationIdsFromEnv(env)`.
  
  `@sarrafjs/testing`: `createMockFetch` records form bodies as `request.form`.
- 20a3ec0: **Requires Node.js 22 or later** (was 18). Node 18 and 20 are end-of-life and no longer tested.
  
  Upgrade to zod 4. Option validation behaves the same: Paymob `integrationIds` still accepts any subset of payment methods, and an unsupported currency still throws `UNSUPPORTED_CURRENCY`. Validation error messages may be worded differently. `@sarrafjs/express` is now tested against Express 5.

### Patch Changes

- 0ebf532: Packages are published under the `@sarrafjs` npm scope (`npm i @sarrafjs/core @sarrafjs/paymob`). Point `repository`, `homepage` and `bugs` at github.com/muhammedalaa1/sarraf, the repository the packages are built and published from (npm provenance checks that they match).
