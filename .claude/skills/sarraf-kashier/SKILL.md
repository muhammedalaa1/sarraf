---
name: sarraf-kashier
description: Full context on the Kashier integration in the Sarraf SDK (packages/kashier) — signed hosted payment page (HPP) hash, Payment Sessions v3 (beta), order lookup by merchantOrderId, refunds and same-day voids on the FEP API, x-kashier-signature webhooks (HMAC-SHA256 over query-string-encoded signatureKeys), redirect signatures, and what was confirmed in the real Kashier sandbox. Use this whenever the task mentions Kashier, @sarrafjs/kashier, KASHIER_* env vars, MID-… merchant ids, hpp hash, signatureKeys, fixtures/kashier, or a Kashier webhook / refund / void problem — even if the user doesn't say "skill".
---

# Kashier in Sarraf

Kashier is the adapter that has been checked against its real sandbox (2026-10-21): hash, redirect,
webhooks, order lookup, partial and full refunds and void all have recorded fixtures in
`fixtures/kashier/sandbox-*.json`. Treat those fixtures as ground truth over Kashier's docs — in
several places the sandbox contradicts the docs (see `references/verification.md`). Read
`sarraf-adapters` too if the change touches the shared contract.

## Files

| File | Responsibility |
|---|---|
| `packages/kashier/src/config.ts` | Options schema, `KASHIER_URLS` (checkout / api / fep per mode), `amountFormat`, currencies |
| `src/client.ts` | Raw HTTP: `createSession` (beta), `findOrder`, `refundOrder`, `voidOrder` |
| `src/signature.ts` | HPP order hash, redirect signature, webhook signature (`query-string`) |
| `src/mappers.ts` | `KASHIER_STATUS_TABLE`, `mapKashierStatus` (webhook events), `mapKashierOrderStatus` (lookups), `toKashierPayment`, `toKashierOrderPayment`, `KASHIER_METHOD_NAMES`, `formatKashierAmount` |
| `src/webhooks.ts` | inspect / verify / parse, refund webhooks enriched with order totals, redirect verification |
| `src/adapter.ts` | `KashierProvider`: capabilities, checkout (hpp / session), getPayment, refund, cancel |
| `src/testing.ts` | Webhook/redirect builders and signers |
| `test/adapter.test.ts`, `test/signature.test.ts` | Conformance + fixture-driven tests |
| `apps/docs/src/content/docs/providers/kashier.md` | Public guide — keep in sync |

## Things that are easy to get wrong

- **Two keys.** `apiKey` (the *Payment API key*) signs the HPP hash and verifies redirects and
  webhooks. `secretKey` authorizes server calls (`Authorization: <secretKey>`, no scheme). Without
  `secretKey`, getPayment/refund/cancel are `"unsupported"`.
- **Amounts are major-unit strings** (`"250.00"`, or `"250"` with `amountFormat: "trimmed"`). The
  hash and the URL must use the identical string.
- **Ids.** Checkout uses your `reference` as Kashier's `orderId` / `merchantOrderId`, so
  `checkout.payment.providerPaymentId === reference`. After payment, Kashier's own order id (from the
  webhook `kashierOrderId` or lookup `orderId`) is what refunds and voids target.
- **Lookups only work by `reference`.** `GET /v3/payment/orders?search=` is a partial match; the
  adapter picks the exact `merchantOrderId`. A `providerPaymentId`-only lookup is rejected.
- **Refunds always send an amount.** The sandbox answers HTTP 500 to a refund without one, so a full
  refund needs `reference` to read the remaining amount. Refund success comes from
  `response.result` — `response.status` is the order's new state (`PARTIALLY_REFUNDED`), not a failure.
- **Refunded orders stay `CAPTURED`;** refund state is derived from `totalRefundedAmount`.
- **Webhook signature uses `query-string`'s strict encoding** of the sorted `signatureKeys`;
  `encodeURIComponent` breaks on `* ( ) ' !`. Refund webhooks carry only the refund amount, so the
  adapter re-reads the order for totals (needs `secretKey`).
- **Redirect signature depends on param order** (as received, minus `signature` and `mode`).

## References

- `references/api.md` — endpoints, auth, bodies, responses, which function calls them.
- `references/signatures.md` — HPP hash, redirect, webhook recipes; event and status mapping.
- `references/verification.md` — what each sandbox fixture proved, where the docs are wrong, open
  questions, how to record more.

Kashier docs: `https://developers.kashier.io/`. Not implemented: authorize/capture (`capture:
"unsupported"`), saved-card tokens beyond passing `customerReference` into the hash (⚠️).
