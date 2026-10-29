---
title: Accept payments with Kashier
description: A complete Kashier integration with Sarraf, in Express and in Next.js. Checkout, webhooks, thank-you page, refunds, voids and reconciliation.
sidebar:
  order: 0
---

This guide builds a complete Kashier integration twice, once in **Express** and once in **Next.js (App Router)**. Both use the same Sarraf client and do the same six things:

1. Create a checkout and send the customer to Kashier's hosted payment page.
2. Receive Kashier's webhooks and update the order. **This is the only place an order becomes paid.**
3. Show a thank-you page when the customer comes back.
4. Refund an order, fully or partly.
5. Void (cancel) a payment on the same day.
6. Re-check unfinished orders on a schedule, in case a webhook was lost.

Every Kashier call in this guide is confirmed against Kashier's real sandbox; see [Kashier](/providers/kashier/) for the recorded details.

> Sarraf is not affiliated with Kashier. You use your own Kashier account and keys; money goes from the customer to Kashier to you. Sarraf never holds funds and never sees card numbers.

## How a Kashier payment flows

```text
Your server                          Kashier                         Customer
───────────                          ───────                         ────────
checkout.create() ──signed URL──────────────────────────────────▶   redirect
                                     hosted payment page  ◀───────  enters card, 3-D Secure
                  ◀── webhook "pay" (signed) ── payment done
mark order PAID   (save Kashier's order id)
                                     redirect back ─────────────▶   /thanks?...signature
thank-you page    ◀────────────────────────────────────────────────  (UX only, never mark paid here)

refunds.create()  ── PUT /v3/orders/:id REFUND ─▶
                  ◀── webhook "refund" (signed) ──
payments.cancel() ── PUT /v3/orders/:id VOID ───▶  (same day only)
                  ◀── webhook "void" (signed) ────
```

Two rules keep you safe:

- **The webhook decides the order status, never the redirect.** Customers close tabs and redirect URLs can be replayed.
- **Webhooks are retried, so handle each one once.** Every event has a stable `event.id`; skip ids you have already processed.

## Before you start

**From the Kashier dashboard** (test mode first):

| Value | Where it is used | Env var in this guide |
|---|---|---|
| Merchant ID (`MID-…`) | Identifies you on the hosted page | `KASHIER_MERCHANT_ID` |
| Payment API key | Signs the checkout URL; verifies webhook and redirect signatures | `KASHIER_API_KEY` |
| Secret key | Server calls: order lookup, refunds, voids | `KASHIER_SECRET_KEY` |

Give the secret key's role the **refund permission**, or refunds and voids are rejected.

**A public HTTPS URL for webhooks.** Kashier's servers must reach your webhook route. In development, use a tunnel:

```bash
cloudflared tunnel --url http://localhost:3000   # Express
cloudflared tunnel --url http://localhost:3002   # Next.js
# → https://<random>.trycloudflare.com: use it as PUBLIC_URL
```

You don't need to set a webhook URL in the Kashier dashboard: Sarraf sends `webhookUrl` with every checkout.

**Node.js 22+.**

## Install

```bash
# Express
npm install @sarraf/core @sarraf/kashier @sarraf/express express

# Next.js
npm install @sarraf/core @sarraf/kashier @sarraf/next server-only
```

`.env` (never commit it):

```bash
KASHIER_MERCHANT_ID=MID-xxxx-xxx
KASHIER_API_KEY=...
KASHIER_SECRET_KEY=...
KASHIER_MODE=test          # "live" in production
PUBLIC_URL=https://<your-tunnel-or-domain>
```

## What to store for each order

Kashier identifies an order in two ways, and you need both:

| Field | What it is | Where it comes from | Used for |
|---|---|---|---|
| `reference` | **Your** order id, e.g. `order_8841` | You choose it at checkout | Order lookup, full refunds, voids |
| `kashierOrderId` | **Kashier's** order id (a UUID) | `event.payment.providerPaymentId` in the `payment.succeeded` webhook | Refunds |

`checkout.create()` cannot give you `kashierOrderId`: Kashier creates its order only when the customer pays. Save it from the first `payment.succeeded` webhook.

A minimal order record:

```ts
interface Order {
  reference: string;              // your id, unique per payment attempt
  kashierOrderId?: string;        // from the payment.succeeded webhook
  amount: number;                 // minor units: 25000 = 250.00 EGP
  amountRefunded: number;         // minor units
  status: "pending" | "paid" | "failed" | "partially_refunded" | "refunded" | "canceled";
}
```

The examples below use an in-memory `Map` so they run as is. Use your database in production.

## The Sarraf client (shared)

The client is the same in both frameworks. Create it once, on the server.

```ts
// pay.ts (Express) or lib/pay.ts (Next.js)
import { Sarraf } from "@sarraf/core";
import { kashier } from "@sarraf/kashier";

export const pay = new Sarraf({
  providers: {
    kashier: kashier({
      merchantId: process.env.KASHIER_MERCHANT_ID!,
      apiKey: process.env.KASHIER_API_KEY!,
      secretKey: process.env.KASHIER_SECRET_KEY!, // order lookup, refunds, voids, correct refund webhooks
      mode: process.env.KASHIER_MODE === "live" ? "live" : "test",
    }),
  },
});
```

Bad options fail at startup with `CONFIGURATION_INVALID` and a precise message, not at the first payment.

**Applying events.** Both apps share one function that turns a verified webhook event into an order update:

```ts
// orders.ts
import type { SarrafEvent } from "@sarraf/core";
import type { Order } from "./types";                 // the Order interface above

export const orders = new Map<string, Order>();       // use your database
const processed = new Set<string>();                  // use a unique index on event.id

export async function applyEvent(event: SarrafEvent): Promise<void> {
  if (processed.has(event.id)) return;                // Kashier retries: handle each event once
  const order = orders.get(event.payment.reference);
  if (!order) return;                                 // not one of ours

  switch (event.type) {
    case "payment.succeeded":
      order.status = "paid";
      order.kashierOrderId = event.payment.providerPaymentId; // needed for refunds
      break;
    case "payment.failed":
      order.status = "failed";
      break;
    case "refund.succeeded":
      // Sarraf reads the order's real totals from Kashier, so this is "partially_refunded" or "refunded".
      order.status = event.payment.status === "refunded" ? "refunded" : "partially_refunded";
      order.amountRefunded = event.payment.amountRefunded.value;
      break;
    case "payment.canceled":
      order.status = "canceled";
      break;
  }
  processed.add(event.id);
}
```

Throwing from `applyEvent` makes the webhook answer 500, so Kashier retries later. That is what you want when your database is down.

---

## Express

A complete server: checkout, webhooks, thank-you page, refund, void and a reconcile job.

```ts
// server.ts
import express from "express";
import { isSarrafError } from "@sarraf/core";
import { rawBody, webhookHandler } from "@sarraf/express";
import { pay } from "./pay";
import { applyEvent, orders } from "./orders";

const app = express();
const PUBLIC_URL = process.env.PUBLIC_URL!;

// 1. Webhooks FIRST, before express.json(). Signatures are checked over the exact bytes Kashier
//    sent; express.json() would consume and re-shape the body, and every webhook would fail.
app.post(
  "/api/webhooks/:provider",
  rawBody(),
  webhookHandler(pay, applyEvent),   // 200 when done · 400 bad signature · 404 unknown provider · 500 on throw
);

app.use(express.json());

// 2. Checkout: create the order, then send the customer to Kashier.
app.post("/checkout", async (req, res) => {
  const reference = `order_${Date.now()}`;           // unique per payment attempt
  const amount = 25000;                              // 250.00 EGP, from your cart, never from the client
  orders.set(reference, { reference, amount, amountRefunded: 0, status: "pending" });

  try {
    const checkout = await pay.checkout.create({
      provider: "kashier",
      amount: { value: amount, currency: "EGP" },
      reference,
      customer: { name: req.body.name, email: req.body.email, phone: req.body.phone },
      methods: ["card", "wallet"],
      returnUrl: `${PUBLIC_URL}/thanks`,
      webhookUrl: `${PUBLIC_URL}/api/webhooks/kashier`,
      idempotencyKey: `checkout:${reference}`,       // safe if this handler runs twice
    });
    return res.json({ redirectUrl: checkout.redirectUrl });
  } catch (err) {
    if (isSarrafError(err)) return res.status(400).json({ code: err.code, message: err.message });
    throw err;
  }
});

// 3. Thank-you page. Kashier appends signed params; use them for the message only.
app.get("/thanks", async (req, res) => {
  const result = await pay.redirects.verify("kashier", req.query as Record<string, string>);
  const order = result.reference ? orders.get(result.reference) : undefined;
  if (!order) return res.status(404).send("Order not found");

  if (result.authenticated && result.status === "failed") {
    return res.send("The payment did not go through. You can try again.");
  }
  // The webhook may not have arrived yet; show "confirming" rather than "paid".
  return res.send(order.status === "paid" ? "Thanks! Your payment is confirmed." : "Thanks! Confirming your payment…");
});

// 4. Refund: full (no amount) or partial.
app.post("/orders/:reference/refund", async (req, res) => {
  const order = orders.get(req.params.reference);
  if (!order?.kashierOrderId) return res.status(409).send("Order is not paid yet");

  const refund = await pay.refunds.create({
    provider: "kashier",
    providerPaymentId: order.kashierOrderId,         // Kashier's order id
    reference: order.reference,                      // lets Sarraf compute a full refund's amount
    amount: req.body.amount ? { value: req.body.amount, currency: "EGP" } : undefined,
    reason: req.body.reason,
    idempotencyKey: `refund:${order.reference}:${req.body.requestId}`,
  });
  // The order status changes when the "refund" webhook arrives.
  return res.json({ status: refund.status, refunded: refund.amount });
});

// 5. Void: cancel today's payment before Kashier settles it.
app.post("/orders/:reference/void", async (req, res) => {
  const payment = await pay.payments.cancel({ provider: "kashier", reference: req.params.reference });
  res.json({ status: payment.status });              // "canceled"
});

// 6. Reconcile: re-check orders still pending after 15 minutes.
async function reconcilePending() {
  for (const order of orders.values()) {
    if (order.status !== "pending") continue;
    try {
      const payment = await pay.payments.reconcile({ provider: "kashier", reference: order.reference });
      if (payment.status === "succeeded") {
        order.status = "paid";
        order.kashierOrderId = payment.providerPaymentId;
      } else if (payment.status === "failed") {
        order.status = "failed";
      }
    } catch (err) {
      // NOT_FOUND: the customer never reached the payment page. Leave it, or expire it.
      if (!isSarrafError(err, "NOT_FOUND")) console.error(err);
    }
  }
}
setInterval(reconcilePending, 15 * 60 * 1000);

app.listen(3000, () => console.log("http://localhost:3000"));
```

In the browser, `POST /checkout`, then `window.location.href = redirectUrl`.

Note on the order of middleware: if your app already has `app.use(express.json())` at the top, move the webhook route above it, or the handler answers 500 with `RAW_BODY_MISSING` and logs how to fix it.

---

## Next.js (App Router)

The same features, split into Next.js files. `@sarraf/next` provides the webhook route handler and the thank-you page helper.

### Keep Sarraf on the server

```js
// next.config.mjs
export default {
  serverExternalPackages: ["@sarraf/core", "@sarraf/kashier", "@sarraf/next"],
};
```

```ts
// lib/pay.ts
import "server-only";                    // build error if a client component imports this
import { Sarraf } from "@sarraf/core";
import { kashier } from "@sarraf/kashier";

export const pay = new Sarraf({
  providers: {
    kashier: kashier({
      merchantId: process.env.KASHIER_MERCHANT_ID!,
      apiKey: process.env.KASHIER_API_KEY!,
      secretKey: process.env.KASHIER_SECRET_KEY!,
      mode: process.env.KASHIER_MODE === "live" ? "live" : "test",
    }),
  },
});
```

`@sarraf/core` also throws if it ever runs in a browser: your secret key must never reach client code.

### 1. Checkout: a server action

```ts
// app/actions.ts
"use server";
import { redirect } from "next/navigation";
import { isSarrafError } from "@sarraf/core";
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
      provider: "kashier",
      amount: { value: amount, currency: "EGP" },
      reference,
      customer: {
        name: String(formData.get("name") ?? ""),
        email: String(formData.get("email") ?? ""),
        phone: String(formData.get("phone")),
      },
      methods: ["card", "wallet"],
      returnUrl: `${PUBLIC_URL}/thanks/kashier`,
      webhookUrl: `${PUBLIC_URL}/api/webhooks/kashier`,
      idempotencyKey: `checkout:${reference}`,
    });
    redirectUrl = result.redirectUrl!;
  } catch (err) {
    // e.g. INVALID_REQUEST for a bad phone number: show it on the shop page
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

### 2. Webhooks: one line

```ts
// app/api/webhooks/[provider]/route.ts
import { webhookRoute } from "@sarraf/next";
import { pay } from "@/lib/pay";
import { applyEvent } from "@/lib/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = webhookRoute(pay, applyEvent);
// 200 when done · 400 bad signature · 404 unknown provider · 500 if applyEvent throws (Kashier retries)
```

`webhookRoute` reads the exact body with `req.text()` before verifying. Don't parse the body yourself.

If `applyEvent` only enqueues work, you can answer Kashier first: `webhookRoute(pay, applyEvent, { defer: after })` with `after` from `next/server`. Errors are then only logged, not retried.

### 3. Thank-you page

```tsx
// app/thanks/[provider]/page.tsx
import { notFound } from "next/navigation";
import { verifyRedirect } from "@sarraf/next";
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
  const result = await verifyRedirect(pay, provider, searchParams); // never throws for unsigned redirects
  const order = result.reference ? orders.get(result.reference) : undefined;
  if (!order) notFound();

  if (result.authenticated && result.status === "failed") {
    return <p>The payment did not go through. You can try again.</p>;
  }
  return <p>{order.status === "paid" ? "Thanks! Your payment is confirmed." : "Thanks! Confirming your payment…"}</p>;
}
```

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
  if (!order?.kashierOrderId) throw new Error("Order is not paid yet");

  const refund = await pay.refunds.create({
    provider: "kashier",
    providerPaymentId: order.kashierOrderId,
    reference,                                       // needed for a full refund
    amount: amountMinor ? { value: amountMinor, currency: "EGP" } : undefined,
    idempotencyKey: `refund:${reference}:${amountMinor ?? "full"}:${order.amountRefunded}`,
  });
  revalidatePath(`/admin/orders/${reference}`);
  return { status: refund.status };                  // the order updates when the webhook arrives
}

export async function voidOrder(reference: string) {
  const payment = await pay.payments.cancel({ provider: "kashier", reference });
  revalidatePath(`/admin/orders/${reference}`);
  return { status: payment.status };                 // "canceled"
}
```

### 6. Reconcile: a cron route

```ts
// app/api/cron/reconcile/route.ts
import { isSarrafError } from "@sarraf/core";
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
      const payment = await pay.payments.reconcile({ provider: "kashier", reference: order.reference });
      if (payment.status === "succeeded") {
        order.status = "paid";
        order.kashierOrderId = payment.providerPaymentId;
      } else if (payment.status === "failed") {
        order.status = "failed";
      }
      checked++;
    } catch (err) {
      if (!isSarrafError(err, "NOT_FOUND")) throw err; // NOT_FOUND: never reached the payment page
    }
  }
  return Response.json({ checked });
}
```

Call it every 15 minutes from your scheduler (for example a Vercel Cron Job with `CRON_SECRET`).

---

## Refunds and voids in detail

| | Refund | Void |
|---|---|---|
| Call | `pay.refunds.create({ provider, providerPaymentId, reference?, amount? })` | `pay.payments.cancel({ provider, reference })` |
| When | Any time after the payment | **Same day only**, before Kashier settles |
| Amount | Partial (pass `amount`) or full (omit it) | Always the full payment |
| Needs | `secretKey` with refund permission; `reference` for a full refund | `secretKey` with refund permission; `reference` |
| Webhook | `refund.succeeded` / `refund.failed` | `payment.canceled` |
| Order becomes | `partially_refunded`, then `refunded` | `canceled` |

Things worth knowing:

- **Full refunds need `reference`.** Kashier's API answers HTTP 500 to a refund without an amount, although its docs call the amount optional. Sarraf looks the order up by `reference` and sends the remaining amount. Without `reference`, it throws `INVALID_REQUEST` instead of guessing.
- **Use a refund after the payment day.** A void of an older payment is rejected; refund it instead.
- **Refund webhooks are correct because of `secretKey`.** Kashier's refund webhook only says "3.00 EGP was refunded"; it does not say whether that was everything. Sarraf looks the order up when a refund webhook arrives, so `event.payment.status` is `partially_refunded` or `refunded` with the real `amountRefunded`. Without a `secretKey` it logs a warning and the event only describes the refund.
- **Pass an `idempotencyKey` to refunds.** Calling `refunds.create` twice with the same key returns the first result instead of refunding twice.
- **Never retry a failed refund blindly.** If `refunds.create` throws `TIMEOUT_UNKNOWN_OUTCOME`, `PROVIDER_UNAVAILABLE` or `NETWORK_ERROR`, the refund may or may not have happened. Check first:

```ts
const payment = await pay.payments.get({ provider: "kashier", reference });
// payment.amountRefunded tells you what was actually refunded
```

## Events you will receive

| Event | When | `event.payment.status` |
|---|---|---|
| `payment.succeeded` | The customer paid | `succeeded` |
| `payment.failed` | The payment was declined (`event.payment.failure.message` says why) | `failed` |
| `payment.pending` | Kashier is still waiting for the processor | `pending` |
| `refund.succeeded` | A refund went through | `partially_refunded` or `refunded` |
| `refund.failed` | A refund was rejected; no money moved | `failed` (the refund's outcome; the payment itself is unchanged) |
| `payment.canceled` | A void went through | `canceled` |

Every event has `event.id` (stable across retries, use it to dedupe), `event.payment.reference` (your order id), `event.payment.providerPaymentId` (Kashier's order id), `event.payment.amount` and `event.payment.amountRefunded` (integer minor units), and `event.raw` (Kashier's original payload).

## Money is integers

Amounts are always integers in minor units: `{ value: 25000, currency: "EGP" }` is 250.00 EGP. Sarraf converts to Kashier's format (`"250.00"`) and back without floating-point math. A bare number (`amount: 250`) does not compile, and a non-integer `value` (`250.5`) is rejected at runtime.

```ts
import { toMinor, toMajorString } from "@sarraf/core";
toMinor("250.00", "EGP");      // 25000
toMajorString(25000, "EGP");   // "250.00"
```

## Testing your integration

**Without Kashier at all.** `fakeProvider` behaves like an adapter and signs its own webhooks:

```ts
import { Sarraf } from "@sarraf/core";
import { fakeProvider } from "@sarraf/testing";

const kashier = fakeProvider("kashier");
const pay = new Sarraf({ providers: { kashier } });

await pay.checkout.create({ provider: "kashier", amount: { value: 1000, currency: "EGP" }, reference: "o1", customer: { phone: "01000000000" } });
const event = await pay.webhooks.verifyAndParse("kashier", kashier.simulate("o1", "succeeded"));
await applyEvent(event);   // your code, tested end to end
```

**With Kashier's real payload format.** Build a correctly signed Kashier webhook and post it to your route:

```ts
import { kashierWebhookData, signKashierWebhook } from "@sarraf/kashier/testing";

const req = signKashierWebhook("pay", kashierWebhookData({ merchantOrderId: "o1" }), process.env.KASHIER_API_KEY!);
// req.rawBody and req.headers["x-kashier-signature"]: send them to /api/webhooks/kashier
```

**Against the sandbox.** Use test-mode keys, start your tunnel, pay with a Kashier test card, and watch the webhooks arrive. If a signature fails, debug it without throwing:

```ts
const info = await pay.webhooks.inspect("kashier", { rawBody, headers, query });
// info.signedString: the exact string that was hashed; info.expected vs info.received
```

## Going live checklist

- [ ] Live Merchant ID, Payment API key and secret key, and `KASHIER_MODE=live`. Test and live keys are different.
- [ ] The secret key's role has the refund permission.
- [ ] `PUBLIC_URL` is your real HTTPS domain; the webhook route is reachable from the internet.
- [ ] Webhooks are deduplicated on `event.id` in your database (a unique index).
- [ ] Orders are only marked paid from webhooks or `payments.get`, never from the redirect.
- [ ] Order amounts come from your server, never from the browser.
- [ ] The reconcile job runs every 15 minutes.
- [ ] Keys live in environment variables or a secret manager, never in the repository or client code.

## Troubleshooting

**Every webhook answers 400 `WEBHOOK_SIGNATURE_INVALID`.**
The body was re-serialized before verification. In Express, put the webhook route before `express.json()`; in Next.js, use `webhookRoute` (or `await req.text()`). Then check the key: webhooks are signed with the **Payment API key**, not the secret key. `pay.webhooks.inspect()` shows the exact string that was hashed.

**The webhook route answers 500 `RAW_BODY_MISSING` (Express).**
`express.json()` ran before `rawBody()`. Move the webhook route above it.

**No webhooks arrive in development.**
Kashier cannot reach `localhost`. Use a tunnel and set `PUBLIC_URL` to it. Quick tunnels get a new URL on every restart.

**`payments.get` throws `INVALID_REQUEST` about `reference`.**
Kashier's order search only accepts **your** reference, not Kashier's order id. Pass `reference`.

**A full refund throws "needs `reference`".**
Pass `reference` with `refunds.create`, or pass an explicit `amount`.

**A void is rejected.**
Voids only work on the same day as the payment. Refund instead.

**`CAPABILITY_NOT_SUPPORTED` for `installments` or `bnpl`.**
Those methods are still beta for Kashier. Pass `allowBeta: true` to `new Sarraf()` if you accept that.

## See also

- [Kashier provider reference](/providers/kashier/): signature recipes, status mapping, what was confirmed in the sandbox
- [Express guide](/guides/express/) · [Next.js guide](/guides/nextjs/)
- [Webhooks](/concepts/webhooks/) · [Reconciliation](/concepts/reconciliation/) · [Idempotency](/concepts/idempotency/)
- Runnable examples: [`examples/express-shop`](https://github.com/muhammedalaa1/sarraf/tree/main/examples/express-shop), [`examples/nextjs-shop`](https://github.com/muhammedalaa1/sarraf/tree/main/examples/nextjs-shop)
