---
title: Kashier
description: Kashier adapter. Hosted payment page hash, redirect and webhook signatures.
sidebar:
  order: 2
---

```bash
npm i @sarraf/kashier
```

## Credentials

| Option | Used for |
|---|---|
| `merchantId` | Your MID (`MID-xxx-xxx`) |
| `apiKey` | **Payment API key**: signs the hosted-page hash and verifies redirect and webhook signatures |
| `secretKey` | Server APIs: sessions, order lookup, refunds (beta) |
| `mode` | `"test"` or `"live"`. Test and live MIDs and keys are different |
| `amountFormat` | `"fixed"` (`250.00`, default) or `"trimmed"` (`250`) |

## Checkout (hosted payment page)

Sarraf builds a signed URL to `https://checkout.kashier.io/`:

```text
hash = HMAC-SHA256(apiKey, "/?payment=" + merchantId + "." + orderId + "." + amount + "." + currency)
```

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

Plain `encodeURIComponent` does not encode `* ( ) ' !`, and that is the #1 reported integration bug. Sarraf uses `query-string` itself, and its fixtures cover special characters and Arabic text.

## Redirect verification

`merchantRedirect` gets query parameters plus `signature`. Sarraf signs every parameter except `signature` and `mode`, **in the order received**, as `key=value` pairs joined by `&`, using HMAC-SHA256 with the API key. Use this for the thank-you page only.

## Status mapping ⚠️

| Kashier | Sarraf |
|---|---|
| `pay` + `SUCCESS` | `succeeded` |
| `PENDING` | `pending` |
| `FAILURE` / `FAILED` | `failed` |
| `authorize` + `SUCCESS` | `requires_action` |
| `refund` + `SUCCESS` | `partially_refunded` / `refunded` |
| `void` + `SUCCESS` | `canceled` |

Event names and status strings are to be confirmed with recorded fixtures.

## Refunds and order lookup (beta)

Both need `secretKey` and `allowBeta: true`. `providerPaymentId` is the Kashier order id.
