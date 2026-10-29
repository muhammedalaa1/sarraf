---
title: Paymob
description: Paymob adapter. Unified Checkout, kiosk references, manual capture, saved cards, subscriptions, payment links, refunds and voids.
sidebar:
  order: 1
---

```bash
npm i @sarrafjs/paymob
```

> Building an app? Start with the step-by-step guide: [Accept payments with Paymob](/guides/paymob/) (Express and Next.js).

## Credentials

| Option | Where to find it | Used for | Exposure |
|---|---|---|---|
| `secretKey` | Settings → Developers → API Keys | Intentions, refunds, voids, captures | Secret |
| `publicKey` | Settings → Developers → API Keys | Unified Checkout URL / Pixel | Browser-safe |
| `hmacSecret` | Settings → Developers → API Keys | Verifying callbacks | Secret |
| `apiKey` | Settings → Developers → API Keys | Lookups, full refunds, saved-card inquiry, subscriptions, payment links | Secret |
| `integrationIds` | Settings → Payment Integrations | See below | Config |
| `region` | — | `egypt` · `ksa` · `uae` · `oman` (each has its own base URL) | Config |

Test and live use the same base URL. The mode comes from the keys and integration ids, and **they must match** (test keys with test integration ids). The API key is the same in both modes.

### Integration ids

| Key | Env var (dashboard, scripts) | Used for |
|---|---|---|
| `card` | `PAYMOB_CARD_INTEGRATION_ID` | Card on the Unified Checkout |
| `wallet` | `PAYMOB_WALLET_INTEGRATION_ID` | Mobile wallets (Vodafone Cash, Orange, e& money, WE Pay…) |
| `cash_outlet` | `PAYMOB_KIOSK_INTEGRATION_ID` | Kiosk bill reference (Aman / Masary) |
| `card_auth` | `PAYMOB_CARD_AUTH_INTEGRATION_ID` | Card in Auth mode, for manual capture |
| `card_moto` | `PAYMOB_CARD_MOTO_INTEGRATION_ID` | Charging saved cards, subscription renewals |
| `apple_pay` | `PAYMOB_APPLE_PAY_INTEGRATION_ID` | Offered next to `card` (live ids only) |
| `bnpl` | `PAYMOB_BNPL_INTEGRATION_ID` | valU, Souhoola, Sympl, … |
| `installments` | `PAYMOB_INSTALLMENTS_INTEGRATION_ID` | Bank installments (live ids only) |

`paymobIntegrationIdsFromEnv(process.env)` reads all of them.

### Capability levels

Card and wallet checkout, lookups, refunds, voids and webhooks are `"supported"`. Methods and features that have not been checked against the Paymob sandbox yet are `"beta"`: kiosk, BNPL, installments and capture. Call them with `new Sarraf({ allowBeta: true, … })`.

## Checkout

`checkout.create` calls `POST /v1/intention/` with `Authorization: Token <secretKey>` and returns
`{base}/unifiedcheckout/?publicKey=…&clientSecret=…`. The `client_secret` is **single-use**, so every attempt needs a new checkout.

- `items` must add up to `amount` (Sarraf validates this before calling).
- `customer.phone` is required.
- `methods` maps to your `integrationIds`. With no `methods`, every checkout integration is offered (not `card_auth`, `card_moto` or `cash_outlet`). Pass raw ids with `providerOptions.paymentMethods`.
- **`payment.providerPaymentId` is empty at checkout.** Paymob creates the transaction when the customer pays; the id arrives with the webhook or `payments.reconcile`. Refunds, voids and captures need that transaction id, not the intention's order id.

### Embedding Paymob Pixel

```ts
import { paymobEmbed } from "@sarrafjs/paymob";

const { publicKey, clientSecret } = paymobEmbed(checkout); // send both to the browser
```

### Kiosk (Aman / Masary)

```ts
const checkout = await pay.checkout.create({ provider: "paymob", methods: ["cash_outlet"], amount, reference, customer });
checkout.kind;          // "reference_code"
checkout.referenceCode; // the bill reference the customer pays at a kiosk
checkout.payment.status // "awaiting_payment"
```

Sarraf creates the intention on the kiosk integration and pays its payment key with the `AGGREGATOR` source. `cash_outlet` can't be combined with other methods, and kiosk payments can't be refunded.

### Manual capture

```ts
await pay.checkout.create({ provider: "paymob", amount, reference, customer, providerOptions: { capture: "manual" } });
// webhook → payment.status "requires_action" (authorized, needs capture)
await pay.payments.capture({ provider: "paymob", providerPaymentId }); // full; or pass `amount`
```

Needs `integrationIds.card_auth`. Paymob voids an uncaptured authorization after 14 days.

### Other checkout options

| `providerOptions` | |
|---|---|
| `cardTokens` | Saved card tokens offered on the checkout (max 3), for a customer paying with a saved card |
| `subscription` | `{ planId, startDate? }`: start a subscription with this first payment |
| `addCardToSubscription` | Subscription id: add this checkout's card as a secondary card |
| `extras`, `billingData` | Merged into the intention |

## Webhooks

Set the **transaction processed callback** to `https://your.app/api/webhooks/paymob`. Paymob POSTs `{ type, obj }` and puts the signature in the **`hmac` query parameter**.

| `type` | Event |
|---|---|
| `TRANSACTION` | `payment.*` / `refund.*` |
| `TOKEN` | `card.saved` with `event.card` (`token`, `last4`, `brand`, expiry, holder) |

`SarrafEvent` is a union: narrow on `event.type` (or use `isPaymentEvent` / `assertPaymentEvent`) before reading `event.payment`.

A refund callback describes the refund transaction. With an `apiKey`, Sarraf reads the original transaction (`parent_transaction`) so `event.payment` is the refunded payment with its totals (`partially_refunded` / `refunded`, `amountRefunded`). Without one, it reports the refund transaction.

### Signature recipes

HMAC-SHA512 (lowercase hex), keyed with `hmacSecret`, over the values below concatenated **in this order with no separator**. Booleans become `true` / `false`. Values are used exactly as received (don't reformat dates). Note Paymob's spelling `error_occured`. ⚠️ `null` stringifies as an empty string, which still needs confirming with a recorded callback.

**Transaction** (`obj`):

```text
amount_cents created_at currency error_occured has_parent_transaction id integration_id
is_3d_secure is_auth is_capture is_refunded is_standalone_payment is_voided order.id owner
pending source_data.pan source_data.sub_type source_data.type success
```

**Card token** (`obj`):

```text
card_subtype created_at email id masked_pan merchant_id order_id token
```

**Subscription**: the string `"<trigger_type>for<subscription_data.id>"` (e.g. `suspendedfor1264`), with the HMAC in the body's `hmac` field. Verify these with `extras.subscriptions.verifyWebhook(req)`, not the generic route.

## Status mapping

| Paymob | Sarraf |
|---|---|
| `is_voided: true` | `canceled` |
| `pending: true`, kiosk | `awaiting_payment` ⚠️ |
| `pending: true` | `pending` |
| `success: true`, `is_auth: true`, not captured | `requires_action` ⚠️ |
| `success: true`, `is_capture: true` | `succeeded` ⚠️ |
| `success: true`, not refunded or voided | `succeeded` |
| `success: true`, `is_refunded: true`, partial | `partially_refunded` ⚠️ |
| `success: true`, `is_refunded: true`, full | `refunded` |
| `success: false`, `pending: false` | `failed` (`data.message` becomes `failure.message`) |

## Refunds, voids and captures

```ts
await pay.refunds.create({ provider: "paymob", providerPaymentId: "192036465", amount: { value: 10000, currency: "EGP" } });
await pay.payments.cancel({ provider: "paymob", reference: "order_8841" }); // same-day void, by id or reference
await pay.payments.capture({ provider: "paymob", providerPaymentId: "192036465" });
```

- Leave out `amount` to refund the remaining balance. That reads the payment first, so it needs `apiKey`.
- A void Paymob doesn't accept (not the same business day, already settled) throws `PAYMENT_DECLINED`. Refund instead.
- `refund.payment` is the payment after the refund, when `apiKey` is set.

## Paymob-only APIs

`pay.provider("paymob").extras` (available once the adapter is passed to `new Sarraf`):

```ts
const { extras } = pay.provider("paymob");

// Saved cards: charge without the customer (MOTO), idempotent per key
await extras.cards.charge({ token, reference: "renewal_42", amount, customer, idempotencyKey: "renewal_42" });
await extras.cards.listForOrder(paymobOrderId);

// Intentions
await extras.intentions.update(checkout, { amount: 30000 });
await extras.intentions.retrieve(checkout);

// Subscriptions
const plan = await extras.subscriptions.plans.create({ name: "Monthly", frequency: 30, amount });
const first = await extras.subscriptions.create({ planId: plan.id, amount, reference, customer }); // Checkout
await extras.subscriptions.suspend(id); // resume, cancel, update, get, list, transactions, lastTransaction
await extras.subscriptions.cards.list(id); // add, remove, setPrimary
const event = extras.subscriptions.verifyWebhook(req); // { trigger, subscriptionId, subscription }

// Payment links (QuickLinks)
const link = await extras.links.create({ amount, reference, methods: ["card", "wallet"], expiresAt });
await extras.links.cancel(link.id);
```

Subscriptions need two integrations: `card` (3DS) for the first payment and `card_moto` for renewals. Subscription, link, card-token and lookup calls use the API key's token; intentions, charges, refunds, voids and captures use the secret key.

## Gotchas

- If the integration id mode doesn't match the key mode, intention creation fails.
- Each region has a different base URL. Never hardcode Egypt.
- `notification_url` must be public HTTPS. For local development, use a tunnel (`cloudflared tunnel --url http://localhost:3000`).
- Redirect query parameters are **not** a source of truth. `verifyRedirect` reports `authenticated: true` only when an `hmac` is present and matches.
- Payouts (disbursements) are a separate Paymob product with their own credentials and are not covered by this adapter.
