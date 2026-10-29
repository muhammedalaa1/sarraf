# @sarrafjs/paymob

Paymob adapter for [Sarraf](https://github.com/muhammedalaa1/sarraf): one payment API for Egypt and the Middle East.

📖 **Docs:** [Accept payments with Paymob](https://sarraf-docs.vercel.app/guides/paymob/) (step-by-step, Express and Next.js) · [Paymob reference](https://sarraf-docs.vercel.app/providers/paymob/)

```bash
npm i @sarrafjs/core @sarrafjs/paymob
```

## Setup

```ts
import { Sarraf } from "@sarrafjs/core";
import { paymob, paymobIntegrationIdsFromEnv } from "@sarrafjs/paymob";

export const pay = new Sarraf({
  providers: {
    paymob: paymob({
      region: "egypt",                      // egypt | ksa | uae | oman
      secretKey: process.env.PAYMOB_SECRET_KEY!,
      publicKey: process.env.PAYMOB_PUBLIC_KEY!,
      hmacSecret: process.env.PAYMOB_HMAC_SECRET!,
      apiKey: process.env.PAYMOB_API_KEY,   // lookups, full refunds, subscriptions, links
      integrationIds: paymobIntegrationIdsFromEnv(process.env), // or { card: 123456, wallet: 654321, … }
    }),
  },
});
```

| Option | Where to find it | Used for |
|---|---|---|
| `secretKey` | Dashboard → Settings → Developers → API Keys | Checkouts, refunds, voids, captures |
| `publicKey` | same | The Unified Checkout URL / Pixel (browser-safe) |
| `hmacSecret` | same | Verifying callbacks and redirects |
| `apiKey` | same | Lookups, full refunds, correct refund callbacks, subscriptions, links |
| `integrationIds` | Developers → Payment Integrations | `card`, `wallet`, `cash_outlet` (kiosk), `card_auth`, `card_moto`, `apple_pay`, `bnpl`, `installments` |

Test keys need test integration ids. `paymobIntegrationIdsFromEnv` reads `PAYMOB_CARD_INTEGRATION_ID`, `PAYMOB_WALLET_INTEGRATION_ID`, `PAYMOB_KIOSK_INTEGRATION_ID`, `PAYMOB_CARD_AUTH_INTEGRATION_ID`, `PAYMOB_CARD_MOTO_INTEGRATION_ID`, …

## Take a payment

```ts
const checkout = await pay.checkout.create({
  provider: "paymob",
  amount: { value: 25000, currency: "EGP" },   // minor units: 250.00 EGP
  reference: "order_8841",                     // your id, unique per attempt
  customer: { name: "Mona Ali", email: "mona@example.com", phone: "+201000000000" },
  methods: ["card", "wallet"],
  returnUrl: "https://shop.example/thanks",
  webhookUrl: "https://shop.example/api/webhooks/paymob",
});
// redirect the customer to checkout.redirectUrl (Unified Checkout)
```

```ts
// Your webhook route (or use @sarrafjs/express / @sarrafjs/next / @sarrafjs/nestjs)
const event = await pay.webhooks.verifyAndParse("paymob", { rawBody, headers, query }); // hmac is in the query
if (event.type === "payment.succeeded") {
  // mark paid; save event.payment.providerPaymentId (the transaction id): refunds need it
}
```

```ts
await pay.refunds.create({ provider: "paymob", providerPaymentId: txnId, amount: { value: 5000, currency: "EGP" } });
await pay.payments.cancel({ provider: "paymob", reference: "order_8841" });  // same-day void
await pay.payments.reconcile({ provider: "paymob", reference: "order_8841" }); // needs apiKey
```

## Features

- **Checkout:** Intention API → Unified Checkout URL (the `client_secret` is single-use), or embed it with Paymob Pixel via `paymobEmbed(checkout)`
- **Kiosk (beta):** `methods: ["cash_outlet"]` returns a bill reference (`checkout.kind === "reference_code"`)
- **Manual capture (beta):** `providerOptions: { capture: "manual" }`, then `pay.payments.capture(...)`
- **Callbacks:** HMAC-SHA512 over Paymob's transaction fields (or card-token fields), with `hmac` in the query string. Saved cards arrive as `card.saved` events
- **Lookups:** by transaction id or your reference, using the API-key auth token (cached ~50 minutes)
- **Refunds** (full or partial) and **same-day voids** by transaction id or reference. Refund callbacks report the order's real totals
- **Paymob-only APIs** on `pay.provider("paymob").extras`:
  - `cards.charge(...)`: charge a saved card without the customer (MOTO), idempotent per key
  - `subscriptions`: plans, subscriptions, their cards, and verified subscription callbacks
  - `links`: payment links (QuickLinks)
  - `intentions.update / retrieve`: change an unpaid checkout
- **Test helpers:** `@sarrafjs/paymob/testing` (`paymobTransaction`, `paymobCardToken`, `signPaymobCallback`, `signPaymobTokenCallback`, `signPaymobSubscriptionCallback`, `signPaymobRedirect`)

Card and wallet checkout, lookups, refunds, voids and callbacks are enabled by default. Kiosk, BNPL, installments and capture are beta: pass `new Sarraf({ allowBeta: true, … })` to use them. These flows are built from Paymob's documentation and haven't all been recorded against the real Paymob sandbox yet; see the [reference](https://sarraf-docs.vercel.app/providers/paymob/) for details.

Server-side only. Requires Node.js 22+.

> Not affiliated with Paymob or any other payment provider. Part of [Sarraf](https://github.com/muhammedalaa1/sarraf). Apache-2.0.
