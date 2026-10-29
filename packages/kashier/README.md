# @sarrafjs/kashier

Kashier adapter for [Sarraf](https://github.com/muhammedalaa1/sarraf): one payment API for Egypt and the Middle East.

📖 **Docs:** [Accept payments with Kashier](https://sarraf-docs.vercel.app/guides/kashier/) (step-by-step, Express and Next.js) · [Kashier reference](https://sarraf-docs.vercel.app/providers/kashier/)

```bash
npm i @sarrafjs/core @sarrafjs/kashier
```

## Setup

```ts
import { Sarraf } from "@sarrafjs/core";
import { kashier } from "@sarrafjs/kashier";

export const pay = new Sarraf({
  providers: {
    kashier: kashier({
      merchantId: process.env.KASHIER_MERCHANT_ID!, // MID-xxxx-xxx
      apiKey: process.env.KASHIER_API_KEY!,         // Payment API key: hashes and signatures
      secretKey: process.env.KASHIER_SECRET_KEY,    // server APIs: lookups, refunds, voids
      mode: "test",                                 // "live" in production
    }),
  },
});
```

| Option | Used for |
|---|---|
| `merchantId` | Your MID, from the Kashier dashboard |
| `apiKey` | **Payment API key**: signs the hosted-page hash, verifies webhooks and redirects |
| `secretKey` | Order lookup, refunds and voids. Give its role the refund permission |
| `mode` | `"test"` or `"live"`. Test and live MIDs and keys are different |
| `amountFormat` | `"fixed"` (`250.00`, default) or `"trimmed"` (`250`) |
| `currencies`, `urls` | Accepted currencies (default EGP, USD) and base-URL overrides |

## Take a payment

```ts
const checkout = await pay.checkout.create({
  provider: "kashier",
  amount: { value: 25000, currency: "EGP" },   // minor units: 250.00 EGP
  reference: "order_8841",                     // your id, unique per attempt
  customer: { name: "Mona Ali", email: "mona@example.com", phone: "01000000000" },
  methods: ["card", "wallet"],
  returnUrl: "https://shop.example/thanks",
  webhookUrl: "https://shop.example/api/webhooks/kashier",
});
// redirect the customer to checkout.redirectUrl (Kashier's hosted payment page)
```

```ts
// Your webhook route (or use @sarrafjs/express / @sarrafjs/next / @sarrafjs/nestjs)
const event = await pay.webhooks.verifyAndParse("kashier", { rawBody, headers }); // x-kashier-signature
if (event.type === "payment.succeeded") {
  // mark paid; save event.payment.providerPaymentId (Kashier's order id): refunds need it
}
```

```ts
await pay.refunds.create({ provider: "kashier", providerPaymentId: kashierOrderId, reference: "order_8841" }); // full
await pay.payments.cancel({ provider: "kashier", reference: "order_8841" });   // same-day void
await pay.payments.reconcile({ provider: "kashier", reference: "order_8841" }); // lookup by your reference
```

## Features

- **Checkout:** signed hosted payment page (the same amount string is used in the hash and the URL). `locale: "ar"` for Arabic; `providerOptions.extraParams` for extra page options
- **Webhooks:** `x-kashier-signature`, HMAC-SHA256 of the sorted `signatureKeys`, serialized exactly like `query-string`
- **Redirects:** signature verified over the query params (excluding `signature` and `mode`), in the order received
- **Order lookup** by your reference
- **Refunds**, full or partial (need `secretKey`; a full refund also needs `reference`). Refund webhooks report the order's real totals
- **Same-day voids** with `payments.cancel({ provider: "kashier", reference })`
- **Beta** (`allowBeta: true`): installments, valU (BNPL), and the Payment Sessions flow (`providerOptions: { flow: "session" }`)
- **Test helpers:** `@sarrafjs/kashier/testing` (`kashierWebhookData`, `signKashierWebhook`, `signKashierRedirect`)

Checkout, webhooks, redirects, lookups, refunds and voids are confirmed against Kashier's real sandbox, with recorded fixtures. Not supported yet: authorize/capture, kiosk codes, payment links and subscriptions.

Server-side only. Requires Node.js 22+.

> Not affiliated with Kashier or any other payment provider. Part of [Sarraf](https://github.com/muhammedalaa1/sarraf). Apache-2.0.
