# @sarrafjs/kashier

## 0.2.1

### Patch Changes

- 0e0bd0d: Point `docsUrl` and every README at the docs site, https://sarraf-docs.vercel.app (the old sarraf.dev links were dead), add `homepage` and `bugs` to each package, and expand the npm READMEs with setup, options and examples.
- ff1ebcd: Update `query-string` to 10.0.0. The webhook signature encoding is unchanged; the special-character and Arabic fixtures still verify.
- Updated dependencies [0e0bd0d]
  - @sarrafjs/core@0.2.1

## 0.2.0

### Minor Changes

- b2514e5: Kashier, checked against the real Kashier sandbox with recorded fixtures:
  
  - The hosted-page hash, the redirect signature and the `pay` and `refund` webhook signatures are confirmed. `KASHIER_STATUS_TABLE` marks the confirmed rows `verified: true`.
  - **Fix:** a successful partial refund was reported as `failed`, because Kashier answers with the order's new status (`PARTIALLY_REFUNDED`). The refund outcome is now read from `response.result`. The refund URL no longer has a trailing slash.
  - **New:** same-day voids with `payments.cancel({ provider: "kashier", reference })`. Sarraf voids the order's successful pay transaction with an explicit `targetTransactionId` and `amount`, then returns the order as Kashier reports it (`canceled`). Confirmed in the sandbox, including the `void` webhook (`payment.canceled`).
  - **Fix:** `payments.get` called an endpoint that does not exist. It now uses Kashier's order search (`GET /v3/payment/orders?search=`) and is `supported` with a `secretKey`. Look payments up by `reference`; a `providerPaymentId`-only lookup is rejected with `INVALID_REQUEST`, because Kashier's search does not accept its own order id.
  - **Refunds are now `supported`** (no `allowBeta` needed): partial and full refunds are confirmed. Kashier answers HTTP 500 to a refund without an amount, so a full refund looks the order up by `reference` and sends the remaining amount; pass `reference` with a full refund, or it throws `INVALID_REQUEST`.
  - **Fix:** refund webhooks reported a partial refund as a full refund of a smaller payment. Kashier's refund webhook carries only the refund amount, so the adapter now reads the order totals from the lookup (needs `secretKey`).
  
  `@sarrafjs/testing`: the `Fixture` type now includes `query` (recorded redirects) and `verifiedAgainstRealSignature`.
- 20a3ec0: **Requires Node.js 22 or later** (was 18). Node 18 and 20 are end-of-life and no longer tested.
  
  Upgrade to zod 4. Option validation behaves the same: Paymob `integrationIds` still accepts any subset of payment methods, and an unsupported currency still throws `UNSUPPORTED_CURRENCY`. Validation error messages may be worded differently. `@sarrafjs/express` is now tested against Express 5.

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
