---
title: Kashier
description: Kashier adapter. Hosted payment page hash, redirect and webhook signatures.
sidebar:
  order: 2
---

```bash
npm i @sarraf/kashier
```


> Building an app? Start with the step-by-step guide: [Accept payments with Kashier](/guides/kashier/) (Express and Next.js).

## Credentials

| Option | Used for |
|---|---|
| `merchantId` | Your MID (`MID-xxx-xxx`) |
| `apiKey` | **Payment API key**: signs the hosted-page hash and verifies redirect and webhook signatures |
| `secretKey` | Server APIs: order lookup, refunds, Payment Sessions (beta) |
| `mode` | `"test"` or `"live"`. Test and live MIDs and keys are different |
| `amountFormat` | `"fixed"` (`250.00`, default) or `"trimmed"` (`250`) |

## Checkout (hosted payment page)

Sarraf builds a signed URL to `https://checkout.kashier.io/`:

```text
hash = HMAC-SHA256(apiKey, "/?payment=" + merchantId + "." + orderId + "." + amount + "." + currency)
```

✅ Confirmed against the Kashier sandbox: a checkout signed this way was paid successfully. The hosted page does **not** check the hash when it loads, only when the customer presses Pay, so a wrong hash shows up as a failed payment, not a broken page.

The **same amount string** goes into the hash and the URL. One mismatched character gives "invalid hash" on the hosted page. `orderId` (your `reference`) must be unique per attempt.

`methods` maps to `allowedMethods`: `card`, `wallet`, `installments` → `bank_installments`, `bnpl` → `valu` (the last two are beta).

### Payment Sessions (beta)

```ts
await pay.checkout.create({ provider: "kashier", /* … */ providerOptions: { flow: "session" } });
```

This uses `POST /v3/payment/sessions` with both the `Authorization: <secretKey>` and `api-key: <apiKey>` headers.

## Webhooks

Kashier POSTs `{ event, data }` with the signature in the **`x-kashier-signature`** header.

### Signature recipe

1. Take `data.signatureKeys` and **sort** them.
2. Pick those keys from `data`.
3. Serialize **exactly like the `query-string` library's `stringify`**: strict RFC 3986 encoding (`*` → `%2A`, `(` → `%28`, …), arrays as repeated keys, and `null` as a bare key.
4. HMAC-SHA256 with the **Payment API key**, hex.

✅ Confirmed against a real sandbox webhook ([fixture](https://github.com/muhammedalaa1/sarraf/blob/main/fixtures/kashier/sandbox-webhook-succeeded-1.json)). Kashier signs `amount, channel, currency, kashierOrderId, merchantOrderId, method, orderReference, status, transactionId, transactionResponseCode`; `channel` is `online | e-commerce`, so the signed string contains `channel=online%20%7C%20e-commerce`. `amount` arrives as a JSON number in major units (`10`) and is signed as-is.

Plain `encodeURIComponent` does not encode `* ( ) ' !`, and that is the #1 reported integration bug. Sarraf uses `query-string` itself, and its fixtures cover special characters and Arabic text.

## Redirect verification

`merchantRedirect` gets query parameters plus `signature`. Sarraf signs every parameter except `signature` and `mode`, **in the order received**, as `key=value` pairs joined by `&`, using HMAC-SHA256 with the API key. Use this for the thank-you page only.

✅ Confirmed against a real sandbox redirect ([fixture](https://github.com/muhammedalaa1/sarraf/blob/main/fixtures/kashier/sandbox-redirect-succeeded.json)). Kashier sends `paymentStatus, cardDataToken, maskedCard, merchantOrderId, orderId, cardBrand, orderReference, transactionId, amount, currency, mode, signature`. Note that `amount` comes back trimmed (`10`) even when the checkout sent `10.00`.

## Status mapping

| Kashier | Sarraf |
|---|---|
| `pay` + `SUCCESS` | `succeeded` ✅ |
| `PENDING` | `pending` |
| `FAILURE` / `FAILED` | `failed` |
| `authorize` + `SUCCESS` | `requires_action` |
| `refund` + `SUCCESS` | `partially_refunded` / `refunded` ✅ (totals from the order lookup) |
| `void` + `SUCCESS` | `canceled` |

✅ = confirmed with a recorded sandbox fixture. The other rows still need recorded failure, authorize/capture and void events.

## Order lookup

Needs `secretKey`. Look payments up by **your reference**:

```ts
const payment = await pay.payments.get({ provider: "kashier", reference: "order_8841" });
```

✅ Confirmed in the sandbox: `GET https://test-api.kashier.io/v3/payment/orders?search=<merchantOrderId>`. Kashier's `search` is a partial match on your reference, so Sarraf picks the order whose `merchantOrderId` matches exactly. It does not accept Kashier's own order id, so `payments.get({ providerPaymentId })` is rejected with `INVALID_REQUEST`.

A refunded order stays `CAPTURED` at Kashier; Sarraf derives `partially_refunded` / `refunded` from `totalRefundedAmount` against the order amount.

## Refunds

Need `secretKey`. `providerPaymentId` is the Kashier order id (`kashierOrderId` in webhooks, the redirect's `orderId`), not your reference.

```ts
// Partial refund
await pay.refunds.create({ provider: "kashier", providerPaymentId, amount: { value: 300, currency: "EGP" } });
// Full refund of whatever is left: pass your reference too
await pay.refunds.create({ provider: "kashier", providerPaymentId, reference: "order_8841" });
```

✅ Partial and full refunds confirmed in the sandbox: `PUT /v3/orders/:orderId` with `{ apiOperation: "REFUND", reason, transaction: { amount } }` and the secret key in `Authorization`. The refund outcome is `response.result`; `response.status` is the order's new state (`PARTIALLY_REFUNDED` / `REFUNDED`).

Kashier's docs call `amount` optional, but the sandbox answers **HTTP 500** to a refund without one, and nothing is refunded. This was checked on fresh, never-refunded orders with all three documented shapes: `transaction: {}`, no `transaction` at all, and `transaction: { targetTransactionId }` pointing at the pay transaction. So for a full refund Sarraf looks the order up by `reference` and sends the remaining amount. Without `reference` it throws `INVALID_REQUEST` instead of guessing.

### Refund webhooks

✅ Confirmed in the sandbox: Kashier's `refund` webhook carries only **this refund's** amount, not the order total or earlier refunds. With `secretKey` configured, Sarraf looks the order up when a refund webhook arrives, so `event.payment` has the real totals (`partially_refunded`, `amountRefunded`). Without `secretKey` it logs a warning, and `event.payment` describes only the refund.

## Void

Needs `secretKey`. Cancels a payment before Kashier settles it, which is **the same day only**; after that, refund instead.

```ts
const payment = await pay.payments.cancel({ provider: "kashier", reference: "order_8841" });
// payment.status === "canceled"
```

✅ Confirmed in the sandbox ([fixture](https://github.com/muhammedalaa1/sarraf/blob/main/fixtures/kashier/sandbox-void-succeeded.json)). Sarraf looks the order up by `reference`, finds the successful `pay` transaction and sends `PUT /v3/orders/:orderId` with `{ apiOperation: "VOID", transaction: { targetTransactionId, amount } }`. Kashier's docs say a full void can omit `transaction`; Sarraf always sends both fields, because the same "optional" fields make refunds fail with HTTP 500. It then returns the order as Kashier reports it (`CANCELLED` → `canceled`). Kashier also sends a `void` webhook, which becomes `payment.canceled`.

A void that Kashier does not accept throws `PAYMENT_DECLINED`.
