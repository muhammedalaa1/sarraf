---
title: Quick start
description: Accept your first sandbox payment in five minutes.
---

## 1. Install

```bash
npm i @sarrafjs/core @sarrafjs/paymob @sarrafjs/kashier @sarrafjs/fawry @sarrafjs/express
```

Node 22+. Server-side only: `@sarrafjs/core` throws if it is bundled for a browser.

## 2. Configure providers

Use **sandbox / test** credentials from each provider's dashboard. Configure only the providers you use.

```ts
import { Sarraf } from "@sarrafjs/core";
import { paymob } from "@sarrafjs/paymob";
import { kashier } from "@sarrafjs/kashier";
import { fawry } from "@sarrafjs/fawry";

export const pay = new Sarraf({
  providers: {
    paymob: paymob({
      region: "egypt",
      secretKey: process.env.PAYMOB_SECRET_KEY!,
      publicKey: process.env.PAYMOB_PUBLIC_KEY!,
      hmacSecret: process.env.PAYMOB_HMAC_SECRET!,
      apiKey: process.env.PAYMOB_API_KEY,
      integrationIds: { card: 123456, wallet: 654321 },
    }),
    kashier: kashier({
      merchantId: process.env.KASHIER_MID!,
      apiKey: process.env.KASHIER_API_KEY!,
      mode: "test",
    }),
    fawry: fawry({
      merchantCode: process.env.FAWRY_MERCHANT_CODE!,
      secureKey: process.env.FAWRY_SECURE_KEY!,
      environment: "staging",
    }),
  },
});
```

## 3. Create a checkout

```ts
const checkout = await pay.checkout.create({
  provider: "paymob",
  amount: { value: 250_00, currency: "EGP" },   // 250.00 EGP in minor units
  reference: "order_8841",                      // your order id, unique per attempt
  customer: { name: "Sara Ali", email: "sara@example.com", phone: "+201001234567" },
  returnUrl: "https://shop.example.com/thanks",
  webhookUrl: "https://shop.example.com/api/webhooks/paymob",
  idempotencyKey: "order_8841",
});

if (checkout.kind === "redirect") redirect(checkout.redirectUrl!);
else showCode(checkout.referenceCode!, checkout.expiresAt);   // Fawry cash
```

## 4. Handle webhooks

```ts
import express from "express";
import { rawBody, webhookHandler } from "@sarrafjs/express";

const app = express();
app.post("/api/webhooks/:provider", rawBody(), webhookHandler(pay, async (event) => {
  // event.id is a stable dedupe key: store it with a unique index
  if (event.type === "card.saved") return;   // Paymob saved card: no payment (see Webhooks)
  await orders.update(event.payment.reference, { status: event.payment.status });
}));
```

The webhook is the source of truth. The customer redirect is only for the thank-you page.

## 5. Reconcile

Webhooks can be lost. Every few minutes, re-check orders that are still `pending` or `awaiting_payment` after 15 minutes:

```ts
const payment = await pay.payments.reconcile({ provider: "fawry", reference: "order_8841" });
```

## Try it without accounts

`@sarrafjs/testing` ships a `fakeProvider()` that behaves like a provider and can simulate signed webhooks. All three [examples](https://github.com/muhammedalaa1/sarraf/tree/main/examples) run in demo mode with no credentials.
