# Kashier verification state

Confirmed against the real Kashier sandbox on 2026-10-21. Update this file when something new is
recorded or a behaviour changes.

## What each fixture proves (`fixtures/kashier/`)

`sandbox-*` files are real recordings (`"source": "sandbox"`); the rest are synthetic.

| Fixture | Proves |
|---|---|
| `sandbox-checkout.json` | HPP URL + hash recipe accepted by Kashier (`hpp-hash.json` is a synthetic unit case of the same recipe) |
| `sandbox-redirect-succeeded.json` | Redirect signature recipe and param order (`redirect-success.json` is synthetic) |
| `sandbox-webhook-succeeded-1/2.json` | `pay` webhook signature + mapping |
| `sandbox-webhook-refund-partial.json`, `sandbox-webhook-refund-full.json`, `-full-fresh.json` | Refund webhook carries only the refund amount → totals must come from lookup |
| `sandbox-webhook-void.json` | `void` webhook → `canceled` |
| `sandbox-order-partially-refunded.json`, `sandbox-order-refunded.json` | Order lookup shape; order stays CAPTURED, refunds in `totalRefundedAmount` |
| `sandbox-refund-partial-succeeded.json` | Refund response: `response.result` SUCCESS while `response.status` is PARTIALLY_REFUNDED |
| `sandbox-refund-full-succeeded.json`, `sandbox-refund-full-fresh-succeeded.json` | Full refund with explicit remaining amount works |
| `sandbox-refund-full-no-amount.json`, `sandbox-refund-full-target-transaction.json`, `sandbox-refund-full-error.json` | Refund without amount → HTTP 500 (docs say amount is optional — wrong) |
| `sandbox-void-succeeded.json` | Void with `targetTransactionId` + `amount` |
| `webhook-special-chars.json` (synthetic) | Locks the `query-string` encoding of `* ( ) ' !` |
| `webhook-pay-*`, `webhook-refund-partial.json` | Synthetic shapes kept for edge cases |

## Where the docs and the sandbox disagree

- Refund `transaction.amount` is documented optional; the sandbox 500s without it.
- Order search does not accept Kashier's own order id; only `merchantOrderId`.
- The refund call's `response.status` is the order state, not the refund result.

## Still unconfirmed (⚠️)

- Payment Sessions v3 (`flow: "session"`) — beta.
- `authorize` / `capture` events and any capture API — adapter declares capture unsupported.
- Installments / valU method names on the hosted page — beta.
- `customerReference` (saved card) in the hash.
- Live base URLs.

## Recording more

`.env.sandbox`: `KASHIER_MERCHANT_ID`, `KASHIER_API_KEY`, `KASHIER_SECRET_KEY`,
optional `KASHIER_SANDBOX_REFERENCE` (paid test order for the lookup contract test). Then
`pnpm record-fixtures checkout kashier`, `status kashier <reference>`,
`refund kashier <kashierOrderId> [amount] --reference <ref>`, `cancel kashier <reference>`,
`webhook` (tunnel + `SANDBOX_PUBLIC_URL`). Fixtures are re-signed with
`test_payment_api_key_do_not_use`. `pnpm test:sandbox` runs the Kashier contract tests.
