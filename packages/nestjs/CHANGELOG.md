# @sarrafjs/nestjs

## 0.2.1

### Patch Changes

- 0e0bd0d: Point `docsUrl` and every README at the docs site, https://sarraf-docs.vercel.app (the old sarraf.dev links were dead), add `homepage` and `bugs` to each package, and expand the npm READMEs with setup, options and examples.
- Updated dependencies [0e0bd0d]
  - @sarrafjs/core@0.2.1

## 0.2.0

### Minor Changes

- 1c78722: New packages. `@sarrafjs/next`: `webhookRoute()` turns provider webhooks into a verified App Router route handler, and `verifyRedirect()` reads thank-you page params without throwing for providers that don't sign redirects. `@sarrafjs/nestjs`: `SarrafModule.forRoot()` / `forRootAsync()` registers the client (`@InjectSarraf()`) and a `POST /webhooks/:provider` controller that dispatches verified events to `@OnSarrafEvent()` methods.

### Patch Changes

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
- 0ebf532: Packages are published under the `@sarrafjs` npm scope (`npm i @sarrafjs/core @sarrafjs/paymob`). Point `repository`, `homepage` and `bugs` at github.com/muhammedalaa1/sarraf, the repository the packages are built and published from (npm provenance checks that they match).
- Updated dependencies [ba96437]
- Updated dependencies [0ebf532]
- Updated dependencies [20a3ec0]
  - @sarrafjs/core@0.2.0
