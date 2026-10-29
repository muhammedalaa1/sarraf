---
title: Fawry
description: Fawry adapter. PayAtFawry reference codes, status v2, V2 notifications.
sidebar:
  order: 3
---

```bash
npm i @sarrafjs/fawry
```

## Credentials

| Option | Used for |
|---|---|
| `merchantCode` | Identifies you |
| `secureKey` | Appended to **every** signature |
| `environment` | `staging` (`atfawry.fawrystaging.com`) or `production` |
| `confirmWithStatusQuery` | Re-query the status after a valid notification (default `true`) |

Fawry signatures are **plain SHA-256** of a concatenated string ending with the secure key, not HMAC. Amounts always use **exactly two decimals** (`250.00`).

:::note
Sandbox access may require merchant onboarding. Request it early.
:::

## Checkout: PayAtFawry (cash)

```ts
const checkout = await pay.checkout.create({ provider: "fawry", amount, reference, customer, expiresInSeconds: 48 * 3600 });
// checkout.kind === "reference_code"
// show: "Pay at any Fawry outlet with code {checkout.referenceCode} before {checkout.expiresAt}"
```

The payment starts as `awaiting_payment`. Customers can pay hours or days later, so use webhooks plus [reconciliation](/concepts/reconciliation/).

### Hosted card / wallet (beta)

`methods: ["card"]` or `["wallet"]` with a `returnUrl` creates a FawryPay hosted checkout link (`kind: "redirect"`). Create cash and card checkouts separately.

## Signature recipes

Each endpoint uses a **different field order**, and each has its own function:

| Endpoint | String hashed (then `+ secureKey`) |
|---|---|
| Charge | `merchantCode + merchantRefNum + customerProfileId + paymentMethod + amount(2dp)` ✅ |
| Status v2 | `merchantCode + merchantRefNumber` ✅ |
| Refund | `merchantCode + referenceNumber + refundAmount(2dp) + reason` ⚠️ |
| Cancel unpaid | `merchantAccount + orderRefNo + lang` ⚠️ |
| Hosted init | `merchantCode + merchantRefNum + customerProfileId + returnUrl + (itemId + quantity + price(2dp))…` ⚠️ |
| V2 notification | `fawryRefNumber + merchantRefNumber + paymentAmount(2dp) + orderAmount(2dp) + orderStatus + paymentMethod + paymentRefrenceNumber` ⚠️ |

Note Fawry's spelling `paymentRefrenceNumber`. JSON parsers turn `250.00` into `250`, so Sarraf re-formats amounts before it hashes them.

## Notifications

Configure the V2 server notification URL on your Fawry account. **V1 notifications (MD5) are not supported.** Sarraf rejects them with an explanation; ask Fawry to enable V2.

With `confirmWithStatusQuery` (the default), Sarraf calls status v2 after a valid signature and trusts the status API if the two disagree.

## Status mapping ⚠️

| Fawry `orderStatus` | Sarraf |
|---|---|
| `NEW` / `UNPAID` | `awaiting_payment` (cash) / `pending` (card) |
| `PAID` | `succeeded` |
| `EXPIRED` | `expired` |
| `CANCELED` / `CANCELLED` | `canceled` |
| `REFUNDED` | `refunded` |
| `PARTIAL_REFUNDED` | `partially_refunded` |
| `FAILED` | `failed` |

## Gotchas

- Amount formatting is the #1 cause of signature mismatches.
- Status lookup is **by merchant reference**, not by Fawry reference number.
- Fawry expects local mobile numbers (`01001234567`). Sarraf converts `+20…` for you.
