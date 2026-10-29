# Kashier signatures and status mapping

All HMAC-SHA256, lowercase hex, keyed with the **Payment API key** (`apiKey`).

## Hosted page hash (`kashierOrderHash`)

Signed string: `/?payment=<merchantId>.<orderId>.<amount>.<currency>` plus `.<customerReference>`
when given (⚠️ the customerReference variant is unconfirmed). `amount` is the exact major-unit string
used in the URL. Fixture: `fixtures/kashier/hpp-hash.json`, sandbox checkout `sandbox-checkout.json`.

## Redirect (`kashierRedirectSignedString`)

Every `merchantRedirect` query param except `signature` and `mode`, **in the order received**, as
`key=value` (decoded values) joined with `&`. Express keeps insertion order in `req.query`; pass a
`URLSearchParams` or entries array to be safe. Result: `paymentStatus` → status via
`mapKashierStatus("pay", …)`, `merchantOrderId` → reference, `orderId`/`transactionId` → id.
Fixture: `sandbox-redirect-succeeded.json`. UX only.

## Webhook (`kashierWebhookSignedString`)

- Signature header: `x-kashier-signature`.
- Body: `{ event, data }`; `data.signatureKeys` lists the signed fields.
- Signed string: sort `signatureKeys`, pick those keys from `data`, serialize with
  `query-string`'s `stringify` (strict RFC 3986, arrays as repeated keys, null as bare key).
  Plain `encodeURIComponent` / `URLSearchParams` differ on `* ( ) ' !` (fixture
  `webhook-special-chars.json`).
- Events: `pay`, `refund`, `void` confirmed; `authorize`, `capture` mapped but unrecorded.

## Event → Sarraf event

- `pay` SUCCESS → `payment.succeeded`; FAILURE/FAILED/DECLINED/ERROR → `payment.failed`;
  PENDING/INITIATED/"" → `payment.pending`; EXPIRED → `payment.expired`.
- `void` SUCCESS → `canceled` → `payment.canceled`.
- `refund`: type `refund.succeeded` / `refund.failed`. The webhook only has the refund amount, so on
  success the adapter calls `findOrder(reference)` and reports the order (`partially_refunded` /
  `refunded`, real totals). Without `secretKey` it warns and reports the webhook data.
- Event id: `kashier:<transactionId>[:refund]:<status>`.

## Status tables

`mapKashierStatus` (webhooks/redirects) — status first, then event: SUCCESS/CAPTURED/APPROVED +
refund → refunded/partially_refunded, + void → canceled, + authorize → requires_action, else
succeeded.

`mapKashierOrderStatus` (lookups): CAPTURED/PAID/SUCCESS → succeeded / partially_refunded /
refunded from `totalRefundedAmount`; REFUNDED; PARTIALLY_REFUNDED; AUTHORIZED → requires_action;
FAILED/REJECTED → failed; CANCELLED/CANCELED/VOIDED/REVERSED → canceled; EXPIRED → expired; else pending.

Methods (`mapKashierMethod`): contains card → card, wallet → wallet, installment → installments,
valu/bnpl/souhoola/aman → bnpl, bank → bank_transfer, else other.

`KASHIER_STATUS_TABLE` marks verified rows with their fixture path — keep that convention.
