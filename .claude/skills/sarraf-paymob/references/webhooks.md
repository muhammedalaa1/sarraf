# Paymob callbacks, signatures and event mapping

## Callback types

| Kind | Transport | Signature | Handled by |
|---|---|---|---|
| Transaction processed | POST JSON `{type:"TRANSACTION", obj}` to the integration's webhook URL or the intention's `notification_url` | `?hmac=` query param, transaction recipe | `pay.webhooks.verifyAndParse("paymob", …)` → `PaymentEvent` |
| Card token | POST JSON `{type:"TOKEN", obj}` (same URL) | `?hmac=` query param, token recipe | same route → `CardSavedEvent` (`card.saved`) |
| Transaction response (redirect) | Browser GET to `redirection_url` with flattened query params | `hmac` query param, redirect recipe | `pay.redirects.verify` (UX only) |
| Subscription | POST JSON `{paymob_request_id, trigger_type, subscription_data{…}, hmac}` | body `hmac` | `extras.subscriptions.verifyWebhook(req)` — deliberately not the generic route |

A body without `type` is treated as TRANSACTION. Any other `type` is rejected with a clear reason.

## Recipes

All HMAC-SHA512, lowercase hex, key = `hmacSecret`, values concatenated with **no separator** in
the listed order (not sorted). Booleans as `true`/`false`; numbers as plain strings; dates exactly as
received. `null`/missing → `""` (⚠️ unconfirmed). Paymob spells `error_occured`.

**Transaction** (`PAYMOB_TRANSACTION_HMAC_FIELDS`, paths relative to `obj`):

```
amount_cents created_at currency error_occured has_parent_transaction id integration_id
is_3d_secure is_auth is_capture is_refunded is_standalone_payment is_voided order.id owner
pending source_data.pan source_data.sub_type source_data.type success
```

Docs sample string: `1000002024-06-13T11:33:44.592345EGPfalsefalse1920364654097558truefalsefalsefalsetruefalse217503754302852false2346MasterCardcardtrue`.

**Redirect** (`PAYMOB_REDIRECT_HMAC_FIELDS`): same list with `order.id` → `order`; dotted
`source_data.*` names kept as query keys. ⚠️ unconfirmed. The docs name it `order_id` in one place.

**Card token** (`PAYMOB_TOKEN_HMAC_FIELDS`): `card_subtype created_at email id masked_pan merchant_id order_id token`.
`obj` also carries `cardholder_name`, `expiry_month`, `expiry_year`, `user_added`, `next_payment_intention`.

**Subscription**: the string `"<trigger_type>for<subscription_data.id>"`, e.g. `suspendedfor1264`.
Triggers include "Subscription Created", suspended, canceled, resumed, updated, add_secondry_card
(Paymob's spelling), change_primary_card, delete_card, register_webhook, "Successful Transaction",
"Failed Transaction", "Failed Overdue Transaction".

Every recipe has a `*SignedString` helper; `inspectWebhook` returns it so a mismatch can be diffed.

## Event mapping (parsePaymobWebhook)

- TRANSACTION: `toPaymobPayment(obj)` → `buildEvent`, id `paymob:<obj.id>:<status>`.
- If `obj.is_refund` (true or "true"): type `refund.succeeded` / `refund.failed` by `success`; with an
  `apiKey` and `parent_transaction`, `event.payment` is the parent re-read via
  `GET /api/acceptance/transactions/{parent}` (totals: `partially_refunded` / `refunded`,
  `amountRefunded`). Lookup failure logs a warning and falls back to the refund txn.
- Void callbacks (`is_void`/`is_voided`) → `canceled` → `payment.canceled`.
- TOKEN: `card.saved` with `card = toSavedCard(obj)` (last4 from `masked_pan`), `providerOrderId = obj.order_id`,
  id `paymob:<obj.id>:card.saved`. The token callback has no merchant reference — link it to your
  order through the Paymob order id.

## Debugging a rejected callback

1. `pay.webhooks.inspect("paymob", req)` → compare `signedString` with the fields in the body.
2. Usual causes: wrong secret (HMAC secret, not secret key), query string not passed (`query: req.query`),
   re-serialized body (dates or numbers reformatted), a field that is `null` in this callback.
3. The dashboard inbox (`apps/dashboard`, `/inbox`) shows the same inspection for every request and
   can replay it.
