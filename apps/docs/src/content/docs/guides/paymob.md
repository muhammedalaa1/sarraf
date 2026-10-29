---
title: Accept payments with Paymob
description: A complete Paymob integration with Sarraf, in Express and in Next.js. Unified Checkout, webhooks, thank-you page, refunds, voids, manual capture, kiosk codes, saved cards, subscriptions, payment links and reconciliation.
sidebar:
  order: 0
---

This guide builds a complete Paymob integration twice, once in **Express** and once in **Next.js (App Router)**. Both use the same Sarraf client and do the same six core things:

1. Create a checkout and send the customer to Paymob's **Unified Checkout** (cards, wallets and more on one page).
2. Receive Paymob's callbacks and update the order. **This is the only place an order becomes paid.**
3. Show a thank-you page when the customer comes back.
4. Refund an order, fully or partly.
5. Void (cancel) a payment on the same day.
6. Re-check unfinished orders on a schedule, in case a callback was lost.

Then it adds the Paymob features you can switch on one by one: [embedding the checkout](#embed-the-checkout-paymob-pixel), [kiosk codes](#kiosk-payments-aman--masary), [manual capture](#authorize-now-capture-later), [saved cards](#saved-cards), [subscriptions](#subscriptions) and [payment links](#payment-links).

> Sarraf is not affiliated with Paymob. You use your own Paymob account and keys; money goes from the customer to Paymob to you. Sarraf never holds funds and never sees card numbers.

:::caution[Verification status]
Paymob's flows are built from Paymob's documentation and Postman collections and tested against those shapes. They have **not** yet been recorded against the real Paymob sandbox the way [Kashier](/guides/kashier/) was. Card and wallet checkout, lookups, refunds, voids and callbacks are enabled by default; kiosk, BNPL, installments and capture are **beta** and need `allowBeta: true`. Test in Paymob's test mode before going live, and see [Paymob](/providers/paymob/) for exactly what is still unconfirmed.
:::

## How a Paymob payment flows

```text
Your server                            Paymob                           Customer
───────────                            ──────                           ────────
checkout.create()  ── POST /v1/intention/ ─▶  intention + client_secret
                   ◀── Unified Checkout URL ─
                                                                 ◀───  redirect
                                       Unified Checkout  ◀───────────  card + 3-D Secure, or wallet + OTP
                   ◀── callback TRANSACTION (hmac=…) ── transaction done
mark order PAID    (save Paymob's transaction id)
                                       redirect back ────────────────▶  /thanks?…&hmac=…
thank-you page     ◀──────────────────────────────────────────────────  (UX only, never mark paid here)

refunds.create()   ── POST /api/acceptance/void_refund/refund ─▶
                   ◀── callback TRANSACTION (refund) ──
payments.cancel()  ── POST /api/acceptance/void_refund/void ───▶  (same day only)
                   ◀── callback TRANSACTION (voided) ──
```

Two rules keep you safe:

- **The callback decides the order status, never the redirect.** Customers close tabs and redirect URLs can be replayed.
- **Callbacks are retried, so handle each one once.** Every event has a stable `event.id`; skip ids you have already processed.

## Before you start

**From the Paymob dashboard** (test mode first: flip the "Test mode" switch at the top):

| Value | Where it is | Used for | Env var in this guide |
|---|---|---|---|
| Secret key (`sk_test_…`) | Settings → Developers → API Keys | Creating checkouts, refunds, voids, captures | `PAYMOB_SECRET_KEY` |
| Public key (`pk_test_…`) | Settings → Developers → API Keys | The Unified Checkout URL. Safe for browsers | `PAYMOB_PUBLIC_KEY` |
| HMAC secret | Settings → Developers → API Keys | Verifying callbacks and redirects | `PAYMOB_HMAC_SECRET` |
| API key | Settings → Developers → API Keys | Order lookups, full refunds, correct refund callbacks, subscriptions, links | `PAYMOB_API_KEY` |
| Integration ids | Developers → Payment Integrations | Which payment methods a checkout offers | `PAYMOB_CARD_INTEGRATION_ID`, `PAYMOB_WALLET_INTEGRATION_ID`, … |

Three things that trip people up:

- **Test keys need test integration ids.** Mixing a `sk_test_` key with a live integration id (or the other way round) makes every checkout fail. The API key is the same in both modes.
- **The API key is optional but you want it.** Without it, `payments.get` / `reconcile` are unavailable, full refunds need an explicit amount, and refund callbacks describe only the refund, not the order totals.
- **Pick your region.** Egypt (`accept.paymob.com`), KSA, UAE and Oman each have their own base URL and currency. Sarraf picks it from `region`.

**A public HTTPS URL for callbacks.** Paymob's servers must reach your webhook route. In development, use a tunnel:

```bash
cloudflared tunnel --url http://localhost:3000   # Express
cloudflared tunnel --url http://localhost:3002   # Next.js
# → https://<random>.trycloudflare.com: use it as PUBLIC_URL
```

You don't need to set a callback URL in the dashboard: Sarraf sends `notification_url` (your webhook route) and `redirection_url` (your thank-you page) with every checkout.

**Node.js 22+.**

## Install

```bash
# Express
npm install @sarrafjs/core @sarrafjs/paymob @sarrafjs/express express

# Next.js
npm install @sarrafjs/core @sarrafjs/paymob @sarrafjs/next server-only
```

`.env` (never commit it):

```bash
PAYMOB_REGION=egypt                 # egypt | ksa | uae | oman
PAYMOB_SECRET_KEY=sk_test_...
PAYMOB_PUBLIC_KEY=pk_test_...
PAYMOB_HMAC_SECRET=...
PAYMOB_API_KEY=...
PAYMOB_CARD_INTEGRATION_ID=1234567
PAYMOB_WALLET_INTEGRATION_ID=1234568
# Optional, for the features later in this guide:
# PAYMOB_KIOSK_INTEGRATION_ID=       kiosk bill references (Aman / Masary)
# PAYMOB_CARD_AUTH_INTEGRATION_ID=   card in Auth mode, for manual capture
# PAYMOB_CARD_MOTO_INTEGRATION_ID=   charging saved cards and subscription renewals
PUBLIC_URL=https://<your-tunnel-or-domain>
```

## What to store for each order

Paymob identifies a payment in two ways, and you need both:

| Field | What it is | Where it comes from | Used for |
|---|---|---|---|
| `reference` | **Your** order id, e.g. `order_8841` | You choose it at checkout | Lookups, voids, matching callbacks to orders |
| `paymobTransactionId` | **Paymob's** transaction id (a number, e.g. `192036465`) | `event.payment.providerPaymentId` in the `payment.succeeded` callback | Refunds, captures |

`checkout.create()` cannot give you the transaction id: Paymob creates the transaction only when the customer pays, so `checkout.payment.providerPaymentId` is empty. Save it from the first `payment.succeeded` callback (or from `payments.reconcile`). Don't use the intention or Paymob *order* id for refunds: Paymob refunds transactions, not orders.

A minimal order record:

```ts
// types.ts
export interface Order {
  reference: string;               // your id, unique per payment attempt
  paymobTransactionId?: string;    // from the payment.succeeded callback
  amount: number;                  // minor units (piasters): 25000 = 250.00 EGP
  amountRefunded: number;          // minor units
  status: "pending" | "authorized" | "paid" | "failed" | "partially_refunded" | "refunded" | "canceled";
}
```

The examples use an in-memory `Map` so they run as is. Use your database in production.

## The Sarraf client (shared)

The client is the same in both frameworks. Create it once, on the server.

```ts
// pay.ts (Express) or lib/pay.ts (Next.js)
import { Sarraf } from "@sarrafjs/core";
import { paymob, paymobIntegrationIdsFromEnv } from "@sarrafjs/paymob";

export const pay = new Sarraf({
  providers: {
    paymob: paymob({
      region: (process.env.PAYMOB_REGION as "egypt") ?? "egypt",
      secretKey: process.env.PAYMOB_SECRET_KEY!,
      publicKey: process.env.PAYMOB_PUBLIC_KEY!,
      hmacSecret: process.env.PAYMOB_HMAC_SECRET!,
      apiKey: process.env.PAYMOB_API_KEY,                       // lookups, full refunds, correct refund callbacks
      integrationIds: paymobIntegrationIdsFromEnv(process.env), // reads every PAYMOB_*_INTEGRATION_ID
    }),
  },
  // allowBeta: true,  // only if you use kiosk, capture, BNPL or installments (see below)
});
```

Bad options fail at startup with `CONFIGURATION_INVALID` and a precise message (a missing key, no integration ids, a test secret key with a live public key), not at the first payment.

**Applying events.** Both apps share one function that turns a verified callback into an order update:

```ts
// orders.ts
import type { SarrafEvent } from "@sarrafjs/core";
import type { Order } from "./types";

export const orders = new Map<string, Order>();       // use your database
const processed = new Set<string>();                  // use a unique index on event.id

export async function applyEvent(event: SarrafEvent): Promise<void> {
  if (processed.has(event.id)) return;                // Paymob retries: handle each event once

  // A customer ticked "save card": it has no payment, only a card token.
  if (event.type === "card.saved") {
    await saveCard(event.card);                       // see "Saved cards" below
    processed.add(event.id);
    return;
  }

  const order = orders.get(event.payment.reference);
  if (!order) return;                                 // not one of ours

  switch (event.type) {
    case "payment.succeeded":
      order.status = "paid";
      order.paymobTransactionId = event.payment.providerPaymentId; // needed for refunds
      break;
    case "payment.pending":
      // Manual capture: the card is authorized and waiting for pay.payments.capture().
      if (event.payment.status === "requires_action") {
        order.status = "authorized";
        order.paymobTransactionId = event.payment.providerPaymentId;
      }
      break;
    case "payment.failed":
      order.status = "failed";
      break;
    case "refund.succeeded":
      // With apiKey, Sarraf reads the original transaction, so this is the order's real total.
      order.status = event.payment.status === "refunded" ? "refunded" : "partially_refunded";
      order.amountRefunded = event.payment.amountRefunded.value;
      break;
    case "payment.canceled":
      order.status = "canceled";
      break;
  }
  processed.add(event.id);
}

async function saveCard(card: { token: string; last4?: string; brand?: string }) {
  // Store card.token against the customer. Never store or log full card numbers (Sarraf never sees them).
}
```

Throwing from `applyEvent` makes the webhook answer 500, so Paymob retries later. That is what you want when your database is down.

---

## Express

A complete server: checkout, callbacks, thank-you page, refund, void and a reconcile job.

```ts
// server.ts
import express from "express";
import { isSarrafError } from "@sarrafjs/core";
import { rawBody, webhookHandler } from "@sarrafjs/express";
import { pay } from "./pay";
import { applyEvent, orders } from "./orders";

const app = express();
const PUBLIC_URL = process.env.PUBLIC_URL!;

// 1. Callbacks FIRST, before express.json(). The HMAC is checked over the exact payload Paymob
//    sent (and the `hmac` query parameter); express.json() would consume the body first.
app.post(
  "/api/webhooks/:provider",
  rawBody(),
  webhookHandler(pay, applyEvent),   // 200 when done · 400 bad hmac · 404 unknown provider · 500 on throw
);

app.use(express.json());

// 2. Checkout: create the order, then send the customer to the Unified Checkout.
app.post("/checkout", async (req, res) => {
  const reference = `order_${Date.now()}`;           // unique per payment attempt
  const amount = 25000;                              // 250.00 EGP, from your cart, never from the client
  orders.set(reference, { reference, amount, amountRefunded: 0, status: "pending" });

  try {
    const checkout = await pay.checkout.create({
      provider: "paymob",
      amount: { value: amount, currency: "EGP" },
      reference,
      customer: { name: req.body.name, email: req.body.email, phone: req.body.phone }, // phone is required
      items: [{ name: "T-shirt", unitAmount: { value: 25000, currency: "EGP" }, quantity: 1 }],
      methods: ["card", "wallet"],                    // must have integration ids; omit to offer all
      returnUrl: `${PUBLIC_URL}/thanks`,
      webhookUrl: `${PUBLIC_URL}/api/webhooks/paymob`,
      expiresInSeconds: 3600,
      idempotencyKey: `checkout:${reference}`,       // safe if this handler runs twice
    });
    return res.json({ redirectUrl: checkout.redirectUrl });
  } catch (err) {
    if (isSarrafError(err)) return res.status(400).json({ code: err.code, message: err.message });
    throw err;
  }
});

// 3. Thank-you page. Paymob appends the transaction and an hmac; use them for the message only.
app.get("/thanks", async (req, res) => {
  const result = await pay.redirects.verify("paymob", req.query as Record<string, string>);
  const order = result.reference ? orders.get(result.reference) : undefined;
  if (!order) return res.status(404).send("Order not found");

  if (result.authenticated && result.status === "failed") {
    return res.send("The payment did not go through. You can try again.");
  }
  // The callback may not have arrived yet; show "confirming" rather than "paid".
  return res.send(order.status === "paid" ? "Thanks! Your payment is confirmed." : "Thanks! Confirming your payment…");
});

// 4. Refund: full (no amount) or partial.
app.post("/orders/:reference/refund", async (req, res) => {
  const order = orders.get(req.params.reference);
  if (!order?.paymobTransactionId) return res.status(409).send("Order is not paid yet");

  const refund = await pay.refunds.create({
    provider: "paymob",
    providerPaymentId: order.paymobTransactionId,    // Paymob's transaction id
    amount: req.body.amount ? { value: req.body.amount, currency: "EGP" } : undefined, // omit = the rest (needs apiKey)
    reason: req.body.reason,
    idempotencyKey: `refund:${order.reference}:${req.body.requestId}`,
  });
  // The order status changes when the refund callback arrives.
  return res.json({ status: refund.status, refunded: refund.amount });
});

// 5. Void: cancel today's payment before Paymob settles it.
app.post("/orders/:reference/void", async (req, res) => {
  const order = orders.get(req.params.reference);
  const payment = await pay.payments.cancel(
    order?.paymobTransactionId
      ? { provider: "paymob", providerPaymentId: order.paymobTransactionId }
      : { provider: "paymob", reference: req.params.reference }, // Sarraf finds the transaction (needs apiKey)
  );
  res.json({ status: payment.status });              // "canceled"
});

// 6. Reconcile: re-check orders still pending after 15 minutes. Needs apiKey.
async function reconcilePending() {
  for (const order of orders.values()) {
    if (order.status !== "pending") continue;
    try {
      const payment = await pay.payments.reconcile({ provider: "paymob", reference: order.reference });
      if (payment.status === "succeeded") {
        order.status = "paid";
        order.paymobTransactionId = payment.providerPaymentId;
      } else if (payment.status === "failed") {
        order.status = "failed";
      }
    } catch (err) {
      // NOT_FOUND: the customer never paid (no transaction yet). Leave it, or expire it.
      if (!isSarrafError(err, "NOT_FOUND")) console.error(err);
    }
  }
}
setInterval(reconcilePending, 15 * 60 * 1000);

app.listen(3000, () => console.log("http://localhost:3000"));
```

In the browser, `POST /checkout`, then `window.location.href = redirectUrl`.

If your app already has `app.use(express.json())` at the top, move the webhook route above it, or the handler answers 500 with `RAW_BODY_MISSING` and logs how to fix it.

---

## Next.js (App Router)

The same features, split into Next.js files. `@sarrafjs/next` provides the webhook route handler and the thank-you page helper.

### Keep Sarraf on the server

```js
// next.config.mjs
export default {
  serverExternalPackages: ["@sarrafjs/core", "@sarrafjs/paymob", "@sarrafjs/next"],
};
```

```ts
// lib/pay.ts
import "server-only";                    // build error if a client component imports this
import { Sarraf } from "@sarrafjs/core";
import { paymob, paymobIntegrationIdsFromEnv } from "@sarrafjs/paymob";

export const pay = new Sarraf({
  providers: {
    paymob: paymob({
      region: "egypt",
      secretKey: process.env.PAYMOB_SECRET_KEY!,
      publicKey: process.env.PAYMOB_PUBLIC_KEY!,
      hmacSecret: process.env.PAYMOB_HMAC_SECRET!,
      apiKey: process.env.PAYMOB_API_KEY,
      integrationIds: paymobIntegrationIdsFromEnv(process.env),
    }),
  },
});
```

`@sarrafjs/core` also throws if it ever runs in a browser: your secret key must never reach client code. (The public key is safe to send to the browser; see [Paymob Pixel](#embed-the-checkout-paymob-pixel).)

### 1. Checkout: a server action

```ts
// app/actions.ts
"use server";
import { redirect } from "next/navigation";
import { isSarrafError } from "@sarrafjs/core";
import { pay } from "@/lib/pay";
import { orders } from "@/lib/orders";

const PUBLIC_URL = process.env.PUBLIC_URL!;

export async function checkout(formData: FormData) {
  const reference = `order_${Date.now()}`;
  const amount = 25000;                                // from your cart, on the server
  orders.set(reference, { reference, amount, amountRefunded: 0, status: "pending" });

  let redirectUrl: string;
  try {
    const result = await pay.checkout.create({
      provider: "paymob",
      amount: { value: amount, currency: "EGP" },
      reference,
      customer: {
        name: String(formData.get("name") ?? ""),
        email: String(formData.get("email") ?? ""),
        phone: String(formData.get("phone")),
      },
      methods: ["card", "wallet"],
      returnUrl: `${PUBLIC_URL}/thanks/paymob`,
      webhookUrl: `${PUBLIC_URL}/api/webhooks/paymob`,
      idempotencyKey: `checkout:${reference}`,
    });
    redirectUrl = result.redirectUrl!;
  } catch (err) {
    // e.g. INVALID_REQUEST for a missing phone number: show it on the shop page
    if (isSarrafError(err)) redirect(`/?error=${encodeURIComponent(err.message)}`);
    throw err;
  }
  redirect(redirectUrl);                               // outside try: redirect() works by throwing
}
```

```tsx
// app/page.tsx
import { checkout } from "./actions";

export default function Shop() {
  return (
    <form action={checkout}>
      <input name="name" placeholder="Name" />
      <input name="email" type="email" placeholder="Email" />
      <input name="phone" placeholder="01xxxxxxxxx" required />
      <button type="submit">Pay 250.00 EGP</button>
    </form>
  );
}
```

### 2. Callbacks: one line

```ts
// app/api/webhooks/[provider]/route.ts
import { webhookRoute } from "@sarrafjs/next";
import { pay } from "@/lib/pay";
import { applyEvent } from "@/lib/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = webhookRoute(pay, applyEvent);
// 200 when done · 400 bad hmac · 404 unknown provider · 500 if applyEvent throws (Paymob retries)
```

`webhookRoute` reads the exact body and the `hmac` query parameter before verifying. Don't parse the body yourself.

If `applyEvent` only enqueues work, you can answer Paymob first: `webhookRoute(pay, applyEvent, { defer: after })` with `after` from `next/server`. Errors are then only logged, not retried.

### 3. Thank-you page

```tsx
// app/thanks/[provider]/page.tsx
import { notFound } from "next/navigation";
import { verifyRedirect } from "@sarrafjs/next";
import { pay } from "@/lib/pay";
import { orders } from "@/lib/orders";

export const dynamic = "force-dynamic";

export default async function Thanks({
  params,
  searchParams,
}: {
  params: Promise<{ provider: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { provider } = await params;
  const result = await verifyRedirect(pay, provider, searchParams);
  const order = result.reference ? orders.get(result.reference) : undefined;
  if (!order) notFound();

  if (result.authenticated && result.status === "failed") {
    return <p>The payment did not go through. You can try again.</p>;
  }
  return <p>{order.status === "paid" ? "Thanks! Your payment is confirmed." : "Thanks! Confirming your payment…"}</p>;
}
```

`result.authenticated` is `true` only when Paymob's `hmac` is present and matches. Treat an unauthenticated redirect as "unknown" and wait for the callback.

### 4 and 5. Refund and void: server actions

Protect these with your admin authentication.

```ts
// app/admin/actions.ts
"use server";
import { revalidatePath } from "next/cache";
import { pay } from "@/lib/pay";
import { orders } from "@/lib/orders";

export async function refundOrder(reference: string, amountMinor?: number) {
  const order = orders.get(reference);
  if (!order?.paymobTransactionId) throw new Error("Order is not paid yet");

  const refund = await pay.refunds.create({
    provider: "paymob",
    providerPaymentId: order.paymobTransactionId,
    amount: amountMinor ? { value: amountMinor, currency: "EGP" } : undefined, // omit = the rest (needs apiKey)
    idempotencyKey: `refund:${reference}:${amountMinor ?? "full"}:${order.amountRefunded}`,
  });
  revalidatePath(`/admin/orders/${reference}`);
  return { status: refund.status };                  // the order updates when the callback arrives
}

export async function voidOrder(reference: string) {
  const payment = await pay.payments.cancel({ provider: "paymob", reference });
  revalidatePath(`/admin/orders/${reference}`);
  return { status: payment.status };                 // "canceled"
}
```

### 6. Reconcile: a cron route

```ts
// app/api/cron/reconcile/route.ts
import { isSarrafError } from "@sarrafjs/core";
import { pay } from "@/lib/pay";
import { orders } from "@/lib/orders";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  let checked = 0;
  for (const order of orders.values()) {
    if (order.status !== "pending") continue;
    try {
      const payment = await pay.payments.reconcile({ provider: "paymob", reference: order.reference });
      if (payment.status === "succeeded") {
        order.status = "paid";
        order.paymobTransactionId = payment.providerPaymentId;
      } else if (payment.status === "failed") {
        order.status = "failed";
      }
      checked++;
    } catch (err) {
      if (!isSarrafError(err, "NOT_FOUND")) throw err; // NOT_FOUND: no transaction yet
    }
  }
  return Response.json({ checked });
}
```

Call it every 15 minutes from your scheduler (for example a Vercel Cron Job with `CRON_SECRET`).

---

## Choosing payment methods

`methods` picks which of your integrations the Unified Checkout shows. Each method needs its integration id:

| `methods` | Integration id | Notes |
|---|---|---|
| `card` | `card` (+ `apple_pay` if set) | Visa, Mastercard, Meeza. Apple Pay is offered next to cards when configured (live only) |
| `wallet` | `wallet` | Vodafone Cash, Orange Cash, e& money, WE Pay… The customer confirms with an OTP |
| `cash_outlet` | `cash_outlet` | Kiosk bill reference. Beta, and on its own only: see [Kiosk payments](#kiosk-payments-aman--masary) |
| `bnpl` | `bnpl` | valU, Souhoola, Sympl… Beta |
| `installments` | `installments` | Bank installments (live only). Beta |

- Leave `methods` out to offer **every** checkout integration you configured (not `card_auth`, `card_moto` or `cash_outlet`).
- A method with no integration id throws `CAPABILITY_NOT_SUPPORTED` and names the ids you did configure.
- To pass raw integration ids instead, use `providerOptions: { paymentMethods: [1234567, 1234568] }`.

**Items must add up.** If you pass `items`, their `unitAmount × quantity` must equal `amount`; Sarraf checks before calling Paymob. Without `items`, Sarraf sends one line, `Order <reference>`.

**Billing data.** Paymob requires a name, email and phone. Sarraf fills them from `customer` (missing ones become `"NA"`, which Paymob accepts). Add more fields, like the address for some card integrations, with `providerOptions: { billingData: { street, city, country } }`.

**Metadata.** `metadata` and `providerOptions.extras` go into the intention's `extras` and come back in the callback.

## Embed the checkout (Paymob Pixel)

Instead of redirecting, you can render Paymob's checkout inside your page with **Paymob Pixel**. Create the checkout on the server as usual, then send only the public key and the client secret to the browser:

```ts
import { paymobEmbed } from "@sarrafjs/paymob";

const checkout = await pay.checkout.create({ provider: "paymob", /* … as above */ });
const { publicKey, clientSecret } = paymobEmbed(checkout);   // both are safe for the browser
return { publicKey, clientSecret };
```

Load Pixel in the browser with those two values, following [Paymob's Pixel docs](https://developers.paymob.com/). Everything else in this guide stays the same: the callback still decides the order status. The `clientSecret` is **single-use**, so create a new checkout for every attempt.

## Kiosk payments (Aman / Masary)

The customer gets a bill reference and pays cash at a kiosk. Needs `PAYMOB_KIOSK_INTEGRATION_ID` and `allowBeta: true`.

```ts
const checkout = await pay.checkout.create({
  provider: "paymob",
  methods: ["cash_outlet"],                // on its own: it cannot be combined with other methods
  amount: { value: 25000, currency: "EGP" },
  reference,
  customer: { name, email, phone },
  webhookUrl: `${PUBLIC_URL}/api/webhooks/paymob`,
  expiresInSeconds: 48 * 3600,
});

checkout.kind;            // "reference_code"
checkout.referenceCode;   // show this to the customer: "Pay at any Aman or Masary outlet with code …"
checkout.payment.status;  // "awaiting_payment"
```

When the customer pays, the usual `payment.succeeded` callback arrives. Kiosk payments **cannot be refunded** through Paymob; `refunds.create` throws `CAPABILITY_NOT_SUPPORTED` for them.

## Authorize now, capture later

Reserve the money when the customer pays and take it later, for example when the order ships. Needs `PAYMOB_CARD_AUTH_INTEGRATION_ID` (a card integration in **Auth** mode) and `allowBeta: true`.

```ts
// 1. Checkout in Auth mode (cards only)
await pay.checkout.create({
  provider: "paymob",
  methods: ["card"],
  amount: { value: 25000, currency: "EGP" },
  reference,
  customer,
  returnUrl, webhookUrl,
  providerOptions: { capture: "manual" },
});

// 2. The callback arrives as payment.pending with status "requires_action": authorized, not captured.
//    applyEvent above marks the order "authorized" and saves the transaction id.

// 3. Capture: all of it, or less than authorized
await pay.payments.capture({
  provider: "paymob",
  providerPaymentId: order.paymobTransactionId!,
  amount: { value: 20000, currency: "EGP" },   // omit to capture the full authorization (needs apiKey)
  idempotencyKey: `capture:${order.reference}`,
});

// Changed your mind? Void the authorization instead:
await pay.payments.cancel({ provider: "paymob", providerPaymentId: order.paymobTransactionId! });
```

Paymob voids an uncaptured authorization automatically after **14 days**.

## Saved cards

Paymob can tokenize a card while the customer pays. You then reuse the token in two ways: offer it on the next checkout (the customer still confirms), or charge it yourself without the customer (merchant-initiated, for renewals and top-ups).

**1. Receive the token.** When the customer saves a card, Paymob sends a `TOKEN` callback to the same webhook route. It arrives as a `card.saved` event (already handled in `applyEvent` above):

```ts
if (event.type === "card.saved") {
  event.card.token;        // what you store
  event.card.last4;        // "2346": for display
  event.card.brand;        // "MasterCard"
  event.providerOrderId;   // the Paymob order it was saved on
}
```

Store the token against **your** customer. It is useless without your Paymob keys, but treat it as sensitive anyway.

**2a. The customer pays with a saved card.** Offer up to three tokens on the next checkout:

```ts
await pay.checkout.create({
  provider: "paymob",
  /* … */
  providerOptions: { cardTokens: [savedToken] },
});
```

**2b. You charge the card (no customer present).** Needs `PAYMOB_CARD_MOTO_INTEGRATION_ID`:

```ts
const { extras } = pay.provider("paymob");

const payment = await extras.cards.charge({
  token: savedToken,
  reference: `renewal_${customerId}_${month}`,
  amount: { value: 9900, currency: "EGP" },
  customer: { name, email, phone },
  webhookUrl: `${PUBLIC_URL}/api/webhooks/paymob`,
  idempotencyKey: `renewal_${customerId}_${month}`,   // never charge twice for the same month
});
payment.status;   // "succeeded" or "failed" (payment.failure.message says why)
```

Only charge cards the customer agreed to be charged for. To list the cards saved on a Paymob order: `extras.cards.listForOrder(paymobOrderId)` (needs the API key).

## Subscriptions

Paymob runs the recurring billing: you create a **plan**, the customer pays the first time with 3-D Secure, and Paymob charges the card on schedule. Needs the API key and two integrations: `card` (3DS) for the first payment and `card_moto` for renewals.

```ts
const { extras } = pay.provider("paymob");

// 1. Once: a plan
const plan = await extras.subscriptions.plans.create({
  name: "Pro monthly",
  frequency: 30,                                  // days: 7, 15, 30, 60, 90, 180 or 360
  amount: { value: 9900, currency: "EGP" },
  webhookUrl: `${PUBLIC_URL}/api/webhooks/paymob-subscriptions`,
});

// 2. Per customer: the first payment is a normal checkout, so redirect to checkout.redirectUrl
const checkout = await extras.subscriptions.create({
  planId: plan.id,
  amount: { value: 9900, currency: "EGP" },
  reference: `sub_${customerId}`,
  customer: { name, email, phone },
  returnUrl: `${PUBLIC_URL}/thanks/paymob`,
  webhookUrl: `${PUBLIC_URL}/api/webhooks/paymob`,
});

// 3. Manage it later
await extras.subscriptions.suspend(subscriptionId);
await extras.subscriptions.resume(subscriptionId);
await extras.subscriptions.cancel(subscriptionId);
await extras.subscriptions.update(subscriptionId, { amount: { value: 12900, currency: "EGP" } });
const history = await extras.subscriptions.transactions(subscriptionId);   // Payment[]
```

Each renewal charge arrives as a normal transaction callback on your webhook route. Paymob also sends **subscription callbacks** (suspended, canceled, renewal failed…) with a different shape and signature. Give them their own route and verify them with `extras.subscriptions.verifyWebhook`:

```ts
// Express
app.post("/api/webhooks/paymob-subscriptions", rawBody(), (req, res) => {
  try {
    const event = pay.provider("paymob").extras.subscriptions.verifyWebhook({
      headers: req.headers as Record<string, string>,
      rawBody: (req as RawBodyRequest).rawBody!,       // RawBodyRequest from @sarrafjs/express
      query: req.query as Record<string, string>,
    });
    // event.trigger: e.g. "suspended"; event.subscriptionId; event.subscription.state
    res.sendStatus(200);
  } catch {
    res.sendStatus(400);                            // WEBHOOK_SIGNATURE_INVALID
  }
});
```

```ts
// Next.js: app/api/webhooks/paymob-subscriptions/route.ts
import { pay } from "@/lib/pay";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const rawBody = await req.text();
  try {
    const event = pay.provider("paymob").extras.subscriptions.verifyWebhook({
      headers: req.headers,
      rawBody,
      query: Object.fromEntries(new URL(req.url).searchParams),
    });
    // handle event.trigger / event.subscription
    return new Response("ok");
  } catch {
    return new Response("invalid signature", { status: 400 });
  }
}
```

Subscription cards:

```ts
await extras.subscriptions.cards.list(subscriptionId);                 // SavedCard[]
const addCard = await extras.subscriptions.cards.add(subscriptionId, { amount, reference, customer, returnUrl });
// addCard.redirectUrl: a 3DS checkout where the customer adds a secondary card
await extras.subscriptions.cards.setPrimary(subscriptionId, cardId);
await extras.subscriptions.cards.remove(subscriptionId, cardId);
```

## Payment links

A link you can send by SMS, WhatsApp or email, with no checkout page of your own. Needs the API key.

```ts
const link = await pay.provider("paymob").extras.links.create({
  amount: { value: 50000, currency: "EGP" },
  reference: `invoice_${invoiceId}`,
  methods: ["card", "wallet"],
  description: "Invoice #1042",
  customer: { name, email, phone },
  expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  notificationUrl: `${PUBLIC_URL}/api/webhooks/paymob`,
});

link.url;        // send this to the customer
link.id;         // keep it to cancel the link
link.shortUrl;   // a shorter URL, when Paymob returns one

await pay.provider("paymob").extras.links.cancel(link.id);
```

When a link is paid, the normal `payment.succeeded` callback arrives with your `reference`, so `applyEvent` handles it like any other order.

## Changing an unpaid checkout

Before the customer pays, you can change the amount or items of a checkout, or read it back:

```ts
const { extras } = pay.provider("paymob");
await extras.intentions.update(checkout, { amount: 30000 });   // e.g. a coupon was applied
const intention = await extras.intentions.retrieve(checkout);
```

If the customer already left, it's simpler to create a new checkout with a new `reference`.

---

## Refunds, voids and captures in detail

| | Refund | Void | Capture |
|---|---|---|---|
| Call | `pay.refunds.create({ provider, providerPaymentId, amount? })` | `pay.payments.cancel({ provider, providerPaymentId \| reference })` | `pay.payments.capture({ provider, providerPaymentId, amount? })` |
| When | Any time after the payment | **Same business day**, before Paymob settles | Within 14 days of the authorization |
| Amount | Partial (pass `amount`) or the rest (omit it) | Always the full payment | All, or less than authorized |
| Needs | Secret key; the API key when you omit `amount` | Secret key; the API key when you pass only `reference` | `card_auth` integration, `allowBeta: true`; the API key when you omit `amount` |
| Callback | `refund.succeeded` / `refund.failed` | `payment.canceled` | `payment.succeeded` |
| Order becomes | `partially_refunded`, then `refunded` | `canceled` | `paid` |

Things worth knowing:

- **Refunds target the transaction id**, from `event.payment.providerPaymentId`. Not your reference, and not the Paymob order or intention id.
- **Refund callbacks are correct because of the API key.** Paymob's refund callback describes the refund transaction itself. With `apiKey`, Sarraf reads the original transaction, so `event.payment` is the refunded payment with its real totals. Without it, the event only describes the refund.
- **A void Paymob refuses throws `PAYMENT_DECLINED`** (for example, the payment was already settled). Refund instead.
- **Pass an `idempotencyKey`** to refunds, captures and saved-card charges. Calling twice with the same key returns the first result instead of moving money twice.
- **Never retry a failed money call blindly.** If it throws `TIMEOUT_UNKNOWN_OUTCOME`, `PROVIDER_UNAVAILABLE` or `NETWORK_ERROR`, it may or may not have happened. Check first:

```ts
const payment = await pay.payments.get({ provider: "paymob", providerPaymentId: order.paymobTransactionId! });
// payment.amountRefunded tells you what was actually refunded
```

## Events you will receive

| Event | When | `event.payment.status` |
|---|---|---|
| `payment.succeeded` | The customer paid, or a capture went through | `succeeded` |
| `payment.failed` | Declined (`event.payment.failure.message` says why) | `failed` |
| `payment.pending` | Still processing; or authorized and waiting for capture; or a kiosk code not paid yet | `pending` · `requires_action` · `awaiting_payment` |
| `refund.succeeded` | A refund went through | `partially_refunded` or `refunded` |
| `refund.failed` | A refund was rejected; no money moved | `failed` |
| `payment.canceled` | A void went through | `canceled` |
| `card.saved` | The customer saved a card | (no payment: read `event.card`) |

Every payment event has `event.id` (stable across retries, use it to dedupe), `event.payment.reference` (your order id), `event.payment.providerPaymentId` (Paymob's transaction id), `event.payment.method` (`card`, `wallet`, …), `event.payment.amount` and `event.payment.amountRefunded` (integer minor units), and `event.raw` (Paymob's original payload). `SarrafEvent` is a union: narrow on `event.type` (or use `isPaymentEvent`) before reading `event.payment`.

## Money is integers

Amounts are always integers in minor units: `{ value: 25000, currency: "EGP" }` is 250.00 EGP. That is also Paymob's `amount_cents`, so nothing is converted. Oman (OMR) has **3 decimals**: `{ value: 2500, currency: "OMR" }` is 2.500 OMR.

```ts
import { toMinor, toMajorString } from "@sarrafjs/core";
toMinor("250.00", "EGP");      // 25000
toMajorString(2500, "OMR");    // "2.500"
```

A bare number (`amount: 250`) does not compile, and a non-integer `value` is rejected at runtime.

## Testing your integration

**Without Paymob at all.** `fakeProvider` behaves like an adapter and signs its own callbacks:

```ts
import { Sarraf } from "@sarrafjs/core";
import { fakeProvider } from "@sarrafjs/testing";

const paymob = fakeProvider("paymob");
const pay = new Sarraf({ providers: { paymob } });

await pay.checkout.create({ provider: "paymob", amount: { value: 1000, currency: "EGP" }, reference: "o1", customer: { phone: "01000000000" } });
const event = await pay.webhooks.verifyAndParse("paymob", paymob.simulate("o1", "succeeded"));
await applyEvent(event);   // your code, tested end to end
```

**With Paymob's real payload format.** Build correctly signed Paymob callbacks and post them to your route:

```ts
import { paymobTransaction, signPaymobCallback, signPaymobTokenCallback } from "@sarrafjs/paymob/testing";

const req = signPaymobCallback(
  paymobTransaction({ success: true, amount_cents: 25000, order: { id: 1, merchant_order_id: "o1" } }),
  process.env.PAYMOB_HMAC_SECRET!,
);
// req.rawBody and req.query.hmac: POST them to /api/webhooks/paymob?hmac=…
```

**Against the sandbox.** Use test-mode keys and test integration ids, start your tunnel, and pay with Paymob's test data:

| Method | Test data |
|---|---|
| Card (success) | `5123 4567 8901 2346`, expiry `01/39`, CVV `123` |
| Wallet | `01010101010`, MPin and OTP `123456` |

If a signature fails, debug it without throwing:

```ts
const info = await pay.webhooks.inspect("paymob", { rawBody, headers, query });
// info.signedString: the exact concatenation that was hashed; info.expected vs info.received
```

The [sandbox dashboard](/guides/dashboard/) shows the same thing for every callback it receives, and has a Paymob walkthrough for checkout, refunds, voids and capture.

## Going live checklist

- [ ] Live secret and public keys **and** live integration ids (test and live ids are different). The API key is the same in both modes.
- [ ] The right `region` for your account.
- [ ] `PUBLIC_URL` is your real HTTPS domain; the webhook route is reachable from the internet.
- [ ] Callbacks are deduplicated on `event.id` in your database (a unique index).
- [ ] Orders are only marked paid from callbacks or `payments.get`, never from the redirect.
- [ ] Order amounts come from your server, never from the browser.
- [ ] You store `paymobTransactionId` from `payment.succeeded`; refunds need it.
- [ ] The reconcile job runs every 15 minutes (needs the API key).
- [ ] If you use beta features (kiosk, capture, BNPL, installments), you tested them in test mode and set `allowBeta: true` on purpose.
- [ ] Keys live in environment variables or a secret manager, never in the repository or client code. Only the public key may reach the browser.

## Troubleshooting

**Checkout creation fails right away.**
Almost always a mode mismatch: test keys with live integration ids, or the other way round. Also check the region: an Egypt account does not work with `region: "ksa"`.

**`CAPABILITY_NOT_SUPPORTED: no integration id configured for "wallet"`.**
You asked for a method you didn't configure. Add `PAYMOB_WALLET_INTEGRATION_ID`, or drop it from `methods`.

**Every callback answers 400 `WEBHOOK_SIGNATURE_INVALID`.**
Check you're using the **HMAC secret** (not the secret or API key) from the same account. In Express, put the webhook route before `express.json()`; in Next.js, use `webhookRoute`. Make sure your proxy keeps the `?hmac=` query string. `pay.webhooks.inspect()` shows the exact string that was hashed.

**No callbacks arrive in development.**
Paymob cannot reach `localhost`. Use a tunnel and set `PUBLIC_URL` to it. Quick tunnels get a new URL on every restart, and `notification_url` must be HTTPS.

**`payments.get` or `reconcile` throws `CAPABILITY_NOT_SUPPORTED`.**
Lookups need `apiKey`.

**A refund throws "needs `providerPaymentId`" or Paymob rejects the id.**
Use the **transaction id** from the `payment.succeeded` callback, not the checkout's id or the Paymob order id. `checkout.payment.providerPaymentId` is always empty.

**A full refund throws `CONFIGURATION_INVALID`.**
Without `apiKey`, Sarraf can't read the remaining amount. Pass `amount`, or configure the API key.

**A void throws `PAYMENT_DECLINED`.**
Voids only work on the same business day. Refund instead.

**`CAPABILITY_NOT_SUPPORTED … is beta in this version`.**
Kiosk, capture, BNPL and installments are beta for Paymob. Pass `allowBeta: true` to `new Sarraf()` if you accept that.

**"The client secret has already been used".**
A checkout URL works once. Create a new checkout for each attempt.

## See also

- [Paymob provider reference](/providers/paymob/): HMAC recipes, status mapping, what is still unconfirmed
- [Express guide](/guides/express/) · [Next.js guide](/guides/nextjs/) · [NestJS guide](/guides/nestjs/)
- [Webhooks](/concepts/webhooks/) · [Reconciliation](/concepts/reconciliation/) · [Idempotency](/concepts/idempotency/) · [Errors](/reference/errors/)
- Runnable examples: [`examples/express-shop`](https://github.com/muhammedalaa1/sarraf/tree/main/examples/express-shop), [`examples/nextjs-shop`](https://github.com/muhammedalaa1/sarraf/tree/main/examples/nextjs-shop)
