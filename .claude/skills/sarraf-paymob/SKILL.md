---
name: sarraf-paymob
description: Full context on the Paymob integration in the Sarraf SDK (packages/paymob) — Intention API / Unified Checkout, kiosk references, auth/capture, HMAC-SHA512 callbacks (transaction, card token, subscription), refunds, voids, saved cards (MOTO), subscriptions, payment links, sandbox verification state. Use this whenever the task mentions Paymob, Accept, @sarrafjs/paymob, PAYMOB_* env vars, intentions, integration ids, hmac callbacks, or fixtures/paymob — including debugging a Paymob webhook, recording Paymob sandbox fixtures, or changing anything Paymob does in the dashboard — even if the user doesn't say "skill".
---

# Paymob in Sarraf

Paymob is the Egyptian (and KSA / UAE / Oman) gateway Sarraf treats as its reference adapter. Read
`sarraf-adapters` too if the change touches the shared contract.

## Files

| File | Responsibility |
|---|---|
| `packages/paymob/src/config.ts` | Options schema, regions → base URL + currency, `integrationIds` keys, `paymobIntegrationIdsFromEnv` |
| `src/client.ts` | Raw HTTP: intentions (create/update/retrieve), auth token cache, `authedRequest` (Bearer + 401 retry), transaction lookups, refund, void, capture, `payWithSource` |
| `src/intention.ts` | Sarraf checkout input → intention body (shared by checkout, MOTO charges, subscriptions) |
| `src/adapter.ts` | `PaymobProvider`: capabilities, checkout (redirect + kiosk), getPayment, refund, cancel, capture, webhooks, `extras`, `paymobEmbed` |
| `src/mappers.ts` | `PaymobTransaction` type, `PAYMOB_STATUS_TABLE`, `mapPaymobStatus`, `mapPaymobMethod`, `toPaymobPayment`, `toSavedCard` |
| `src/signature.ts` | HMAC field lists and signers: transaction, redirect, card token, subscription |
| `src/webhooks.ts` | inspect / verify / parse (TRANSACTION → payment events, TOKEN → `card.saved`), redirect verification |
| `src/extras/` | `pay.provider("paymob").extras`: `cards`, `intentions`, `subscriptions`, `links` |
| `src/testing.ts` | `paymobTransaction`, `paymobCardToken`, `signPaymobCallback`, `signPaymobTokenCallback`, `signPaymobSubscriptionCallback`, `signPaymobRedirect` |
| `test/adapter.test.ts`, `test/features.test.ts` | Conformance + unit tests (mock fetch) |
| `apps/docs/src/content/docs/providers/paymob.md` | Public guide — keep in sync |

## Things that are easy to get wrong

- **Three credentials, three auth styles.** `secretKey` → `Authorization: Token sk_…` (intentions,
  refund, void, capture). `apiKey` → `POST /api/auth/tokens` → `Bearer <token>` (lookups,
  subscriptions, links, card-token inquiry). `publicKey` → browser / Unified Checkout / retrieve
  intention. `hmacSecret` only verifies callbacks.
- **Order id ≠ transaction id.** An intention has an order id (`intention_order_id`); money
  operations need the *transaction* id, which exists only after the customer pays. That's why
  `checkout.payment.providerPaymentId` is `""` until a webhook or reconcile fills it.
- **Integration ids pick the method and mode.** Test keys need test integration ids. `card_auth`
  (manual capture), `card_moto` (saved-card charges, subscription renewals) and `cash_outlet` (kiosk)
  are never offered on a default checkout.
- **The HMAC is in the query string** (`?hmac=`) even for the POST callback, over a fixed field
  order — not sorted. Subscription callbacks are different (body `hmac`, `"<trigger>for<id>"`).
- **Refund callbacks describe the refund transaction**, not the payment; the adapter re-reads the
  parent (`parent_transaction`) to report totals (needs `apiKey`).
- **Kiosk payments can't be refunded**; voids work only the same business day.

## What's verified

As of 2026-10-28 nothing Paymob has been recorded against the real sandbox: the four
`fixtures/paymob/callback-*.json` files are synthetic. Card/wallet checkout, lookups, refunds, voids
and webhooks ship as `"supported"` because they predate the beta policy; kiosk, capture, BNPL,
installments are `"beta"`. Before claiming a Paymob behaviour is confirmed, check
`references/verification.md` and the fixture folder. When you record a real fixture, update that file,
the status table (`verified: true` + fixture path) and capability levels.

## References

Read the one you need:

- `references/api.md` — every endpoint: method, URL, auth, request/response fields, which adapter
  function calls it.
- `references/webhooks.md` — callback types, exact HMAC recipes, redirect params, event mapping.
- `references/flows.md` — checkout variants (redirect, Pixel, kiosk, manual capture, saved cards,
  subscriptions, links) and the status table with its caveats.
- `references/verification.md` — what is confirmed vs inferred, open questions, how to record
  fixtures and test against the sandbox.

Source of truth for Paymob behaviour: `https://developers.paymob.com/paymob-docs/` (append `.md` to a
page URL to get readable text; index at `/paymob-docs/llms.txt`) and Paymob's Postman collections at
`github.com/PaymobAccept/API-Postman-Collections`. Out of scope: Payouts (separate product and
credentials) and the legacy iframe / payment-key flow.
