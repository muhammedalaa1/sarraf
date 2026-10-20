---
title: Paymob
description: Paymob adapter. Intention API, Unified Checkout, HMAC-SHA512 callbacks, refunds and voids.
sidebar:
  order: 1
---

```bash
npm i @sarraf/paymob
```

## Credentials

| Option | Where to find it | Used for | Exposure |
|---|---|---|---|
| `secretKey` | Dashboard → Developers | Creating intentions, refunds, voids | Secret |
| `publicKey` | Dashboard → Developers | Unified Checkout URL / Pixel | Browser-safe |
| `hmacSecret` | Dashboard → Developers → HMAC | Verifying callbacks | Secret |
| `apiKey` | Settings → Account info | Transaction inquiry (`getPayment`, `reconcile`) | Secret |
| `integrationIds` | Developers → Payment integrations | One id per method (`card`, `wallet`, …) | Config |
| `region` | — | `egypt` · `ksa` · `uae` · `oman` (each has its own base URL) | Config |

Test and live use the same base URL. The mode comes from the keys and integration ids, and **they must match** (test keys with test integration ids).

## Checkout

`checkout.create` calls `POST /v1/intention/` with `Authorization: Token <secretKey>` and returns
`{base}/unifiedcheckout/?publicKey=…&clientSecret=…`. The `client_secret` is **single-use**, so every attempt needs a new checkout.

- `items` must add up to `amount` (Sarraf validates this before calling).
- `customer.phone` is required.
- `methods` maps to your `integrationIds`. Pass raw ids with `providerOptions.paymentMethods`.

## Webhooks

Set the **transaction processed callback** to `https://your.app/api/webhooks/paymob`. Paymob POSTs `{ type: "TRANSACTION", obj }` and puts the signature in the **`hmac` query parameter**.

### Signature recipe

HMAC-SHA512 (lowercase hex), keyed with `hmacSecret`, over these `obj` fields concatenated **in this order with no separator**:

```text
amount_cents created_at currency error_occured has_parent_transaction id integration_id
is_3d_secure is_auth is_capture is_refunded is_standalone_payment is_voided order.id owner
pending source_data.pan source_data.sub_type source_data.type success
```

Booleans become `true` / `false`. Values are used exactly as received (don't reformat dates). Note Paymob's spelling `error_occured`. ⚠️ `null` stringifies as an empty string, which still needs confirming with a recorded callback.

Saved-card `TOKEN` callbacks are out of scope in v1 and are rejected with a clear reason.

## Status mapping

| Paymob | Sarraf |
|---|---|
| `is_voided: true` | `canceled` |
| `pending: true` | `pending` |
| `success: true`, not refunded or voided | `succeeded` |
| `success: true`, `is_refunded: true`, partial | `partially_refunded` ⚠️ |
| `success: true`, `is_refunded: true`, full | `refunded` |
| `success: false`, `pending: false` | `failed` (`data.message` becomes `failure.message`) |

## Refunds and voids

```ts
await pay.refunds.create({ provider: "paymob", providerPaymentId: "192036465", amount: { value: 10000, currency: "EGP" } });
await pay.payments.cancel({ provider: "paymob", providerPaymentId: "192036465" }); // same-day void
```

Leave out `amount` to refund the remaining balance.

## Gotchas

- If the integration id mode doesn't match the key mode, intention creation fails.
- Each region has a different base URL. Never hardcode Egypt.
- `notification_url` must be public HTTPS. For local development, use a tunnel (`cloudflared tunnel --url http://localhost:3000`).
- Redirect query parameters are **not** a source of truth. `verifyRedirect` reports `authenticated: true` only when an `hmac` is present and matches.
