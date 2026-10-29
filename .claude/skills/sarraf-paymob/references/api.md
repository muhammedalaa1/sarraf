# Paymob endpoints used by Sarraf

Base URL per region (`config.ts` `PAYMOB_REGIONS`): egypt `https://accept.paymob.com` (EGP), ksa
`https://ksa.paymob.com` (SAR), uae `https://uae.paymob.com` (AED), oman `https://oman.paymob.com`
(OMR). Test and live share the host; the keys decide the mode.

Auth legend: **SK** = `Authorization: Token <secretKey>` · **TOK** = `Authorization: Bearer <token>`
from `/api/auth/tokens` (cached ~50 min, `PaymobTokenCache`) · **none**.

| Operation | Method + path | Auth | Sarraf function | Notes |
|---|---|---|---|---|
| Auth token | `POST /api/auth/tokens` `{api_key}` → `{token, profile}` | none | `PaymobTokenCache.get` | Token lasts ~60 min. 401/403 on bad key |
| Create intention | `POST /v1/intention/` | SK | `createIntention` | moneyMoving. 201 → `{id: "pi_test_…", intention_order_id, client_secret, payment_keys[], payment_methods[], status:"intended"}` |
| Update intention | `PUT /v1/intention/{client_secret}/` | SK | `updateIntention` → `extras.intentions.update` | Body must include `accept_order_id` (= `intention_order_id`) |
| Retrieve intention | `GET /v1/intention/element/{public_key}/{client_secret}/` | none | `retrieveIntention` | Only in Postman, not in doc pages |
| Unified Checkout | `{base}/unifiedcheckout/?publicKey=…&clientSecret=…` | — | `unifiedCheckoutUrl` | Docs also list `https://eg.checkout.paymob.com/?…` (and uae/om/ksa); not switched yet |
| Pay with source | `POST /api/acceptance/payments/pay` `{source, payment_token}` | none (payment key authorizes) | `payWithSource` | `source = {identifier:<card token>, subtype:"TOKEN"}` (MOTO) or `{identifier:"AGGREGATOR", subtype:"AGGREGATOR"}` (kiosk → `data.bill_reference`) |
| Transaction by id | `GET /api/acceptance/transactions/{id}` | TOK | `getTransaction` | Full transaction incl. `refunded_amount_cents`, `captured_amount`, `order.merchant_order_id` |
| Transaction by reference | `POST /api/ecommerce/orders/transaction_inquiry` `{auth_token, merchant_order_id}` (or `order_id`) | TOK + body token | `getTransactionByReference` | Returns latest txn (sometimes an array; Sarraf takes the last) |
| Refund | `POST /api/acceptance/void_refund/refund` `{transaction_id, amount_cents}` | SK | `refundTransaction` | Partial allowed. Response is a new txn with `is_refund:true`, `parent_transaction`. 400 "…greater than the maximum refund amount…" |
| Void | `POST /api/acceptance/void_refund/void` `{transaction_id}` | SK | `voidTransaction` | Same business day. Response has `is_void:true`, `parent_transaction` |
| Capture | `POST /api/acceptance/capture` `{transaction_id, amount_cents}` | SK | `captureTransaction` | Auth txns only; ≤ authorized amount. 400 "Capture amount cannot exceed auth amount" |
| Card tokens of an order | `POST /api/acceptance/order_card_tokens` `{auth_token, order_id}` | TOK + body | `extras.cards.listForOrder` | Returns `[{type:"TOKEN", obj}]` |
| Subscription plans | `POST/GET /api/acceptance/subscription-plans`, `PUT …/{id}`, `POST …/{id}/suspend|resume` | TOK | `extras.subscriptions.plans.*` | Fields: `frequency` (7/15/30/60/90/180/360), `name`, `amount_cents`, `integration` (MOTO id), `reminder_days`, `retrial_days`, `plan_type`, `number_of_deductions`, `use_transaction_amount`, `is_active`, `webhook_url` |
| Create subscription | `POST /v1/intention/` with `subscription_plan_id`, `subscription_start_date?` on a 3DS card integration | SK | `extras.subscriptions.create` (→ checkout) | First payment is customer-present 3DS; renewals use the plan's MOTO integration |
| Subscriptions | `GET/PUT /api/acceptance/subscriptions/{id}`, `GET /api/acceptance/subscriptions?…filters`, `POST …/{id}/suspend|resume|cancel` | TOK | `extras.subscriptions.*` | Update fields: `amount_cents`, `ends_at`, `next_billing` |
| Subscription txns | `GET …/{id}/last-transaction`, `GET …/{id}/transactions` | TOK | `lastTransaction`, `transactions` | |
| Subscription cards | `GET …/{id}/card-tokens`, `POST …/{id}/delete-card {card}`, `POST …/{id}/change-primary-card {card}`; add = intention with `subscriptionv2_id` | TOK / SK | `extras.subscriptions.cards.*` | |
| Subscription webhook | `POST …/{id}/register_webhook {url}` | TOK | `registerWebhook` | Postman uses the plan id in the path; description says subscription |
| Payment link | `POST /api/ecommerce/payment-links` (multipart) | TOK | `extras.links.create` | Fields: `amount_cents`, `payment_methods` (repeat), `is_live`, `reference_id` (unique), `expires_at`, `full_name`, `email` (emails link), `phone_number` (SMS), `description`, `notification_url`, `redirection_url`, `collect_*`, `allowed_countries`. Response `{id, client_url, shorten_url, state}` |
| Cancel link | `POST /api/ecommerce/payment-links/cancel` (multipart `payment_link_id`) | TOK | `extras.links.cancel` | |

## Intention request body (intention.ts)

`amount` (cents), `currency`, `payment_methods` (integration ids or names), `items[]` (`name` ≤50,
`amount`, `quantity`, `description?`; must sum to `amount`), `billing_data` (`first_name`,
`last_name`, `email`, `phone_number` required — Sarraf defaults missing names/email to `"NA"`),
`special_reference` (= Sarraf `reference`, returns as `merchant_order_id`), `notification_url`,
`redirection_url`, `expiration` (seconds), `extras` (Sarraf always sets `sarraf_ref`),
`card_tokens[]` (≤3), `subscription_plan_id`, `subscription_start_date`, `subscriptionv2_id`.

## Error shapes

DRF-style: `{"detail": "…"}` or `{"field": ["This field is required."]}`. Gateway result is in
`data.message`, `data.txn_response_code`, `acq_response_code`. HTTP status mapping comes from core
`errorCodeForStatus` (401/403 → AUTHENTICATION_FAILED, 404 → NOT_FOUND, 5xx → PROVIDER_UNAVAILABLE).
No documented rate limits.

## Test data

Cards: `5123456789012346` and `5123450000000008` (Mastercard), `4111111111111111` (Visa) — name
"Test Account", expiry 01/39, CVV 123. Wallet `01010101010`, MPin and OTP `123456`. Apple Pay,
bank installments and some BNPL have live integration ids only.
