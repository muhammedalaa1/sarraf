---
"@sarraf/kashier": minor
"@sarraf/testing": patch
---

Kashier, checked against the real Kashier sandbox with recorded fixtures:

- The hosted-page hash, the redirect signature and the `pay` and `refund` webhook signatures are confirmed. `KASHIER_STATUS_TABLE` marks the confirmed rows `verified: true`.
- **Fix:** a successful partial refund was reported as `failed`, because Kashier answers with the order's new status (`PARTIALLY_REFUNDED`). The refund outcome is now read from `response.result`. The refund URL no longer has a trailing slash.
- **New:** same-day voids with `payments.cancel({ provider: "kashier", reference })`. Sarraf voids the order's successful pay transaction with an explicit `targetTransactionId` and `amount`, then returns the order as Kashier reports it (`canceled`). Confirmed in the sandbox, including the `void` webhook (`payment.canceled`).
- **Fix:** `payments.get` called an endpoint that does not exist. It now uses Kashier's order search (`GET /v3/payment/orders?search=`) and is `supported` with a `secretKey`. Look payments up by `reference`; a `providerPaymentId`-only lookup is rejected with `INVALID_REQUEST`, because Kashier's search does not accept its own order id.
- **Refunds are now `supported`** (no `allowBeta` needed): partial and full refunds are confirmed. Kashier answers HTTP 500 to a refund without an amount, so a full refund looks the order up by `reference` and sends the remaining amount; pass `reference` with a full refund, or it throws `INVALID_REQUEST`.
- **Fix:** refund webhooks reported a partial refund as a full refund of a smaller payment. Kashier's refund webhook carries only the refund amount, so the adapter now reads the order totals from the lookup (needs `secretKey`).

`@sarraf/testing`: the `Fixture` type now includes `query` (recorded redirects) and `verifiedAgainstRealSignature`.
