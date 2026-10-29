# @sarrafjs/core

The core of [Sarraf](https://github.com/muhammedalaa1/sarraf): one payment API for Egypt and the Middle East. **Paymob, Kashier and Fawry** behind one typed interface: one way to create a checkout, one webhook format, one status model, one error type.

📖 **Docs:** [sarraf-docs.vercel.app](https://sarraf-docs.vercel.app/) · [Quick start](https://sarraf-docs.vercel.app/getting-started/quick-start/) · [Accept payments with Paymob](https://sarraf-docs.vercel.app/guides/paymob/) · [Accept payments with Kashier](https://sarraf-docs.vercel.app/guides/kashier/)

```bash
npm i @sarrafjs/core @sarrafjs/paymob      # and/or @sarrafjs/kashier, @sarrafjs/fawry
```

## Quick start

```ts
import { Sarraf, toMinor } from "@sarrafjs/core";
import { paymob, paymobIntegrationIdsFromEnv } from "@sarrafjs/paymob";

const pay = new Sarraf({
  providers: {
    paymob: paymob({
      secretKey: process.env.PAYMOB_SECRET_KEY!,
      publicKey: process.env.PAYMOB_PUBLIC_KEY!,
      hmacSecret: process.env.PAYMOB_HMAC_SECRET!,
      integrationIds: paymobIntegrationIdsFromEnv(process.env),
    }),
  },
});

// 1. Checkout
const checkout = await pay.checkout.create({
  provider: "paymob",
  amount: { value: toMinor("250.00", "EGP"), currency: "EGP" },  // 25000
  reference: "order_8841",
  customer: { phone: "+201000000000" },
  returnUrl: "https://shop.example/thanks",
  webhookUrl: "https://shop.example/api/webhooks/paymob",
});
if (checkout.kind === "redirect") redirectTo(checkout.redirectUrl!);
else showCode(checkout.referenceCode!);                          // Fawry / kiosk reference codes

// 2. Webhooks: the only place an order becomes paid
const event = await pay.webhooks.verifyAndParse("paymob", { rawBody, headers, query });
if (event.type === "payment.succeeded") await markPaid(event.payment.reference);
```

Framework helpers do the webhook part for you: [`@sarrafjs/express`](https://www.npmjs.com/package/@sarrafjs/express), [`@sarrafjs/next`](https://www.npmjs.com/package/@sarrafjs/next), [`@sarrafjs/nestjs`](https://www.npmjs.com/package/@sarrafjs/nestjs).

## The client

| Call | Returns | |
|---|---|---|
| `checkout.create(input)` | `Checkout` | `kind: "redirect"` (`redirectUrl`) or `"reference_code"` (`referenceCode`) |
| `payments.get({ provider, providerPaymentId \| reference })` | `Payment` | Current status from the provider |
| `payments.reconcile(...)` | `Payment` | Same as `get`; use it in scheduled jobs for orders still pending |
| `payments.cancel(...)` | `Payment` | Void a same-day payment / cancel an unpaid one |
| `payments.capture({ provider, providerPaymentId, amount? })` | `Payment` | Capture an authorization (Paymob, beta) |
| `refunds.create({ provider, providerPaymentId, amount?, reason?, idempotencyKey? })` | `Refund` | Omit `amount` for a full refund |
| `webhooks.verifyAndParse(provider, req)` | `SarrafEvent` | Throws `WEBHOOK_SIGNATURE_INVALID` |
| `webhooks.inspect(provider, req)` | `WebhookInspection` | The exact signed string, expected vs received; never throws on mismatch |
| `redirects.verify(provider, query)` | `RedirectResult` | For the thank-you page only |
| `capabilities(provider)` | `Capabilities` | What each provider supports: `"supported"`, `"beta"` or `"unsupported"` |
| `provider(id)` | the adapter | Provider-only APIs, e.g. `pay.provider("paymob").extras` |

The client is typed by the providers you configure: `provider: "fawry"` doesn't compile unless Fawry is configured, and `providerOptions` is narrowed to that provider's options. Beta features throw `CAPABILITY_NOT_SUPPORTED` unless you pass `new Sarraf({ allowBeta: true, … })`.

## What's inside

- **Models:** `Checkout`, `Payment`, `Refund`, `SarrafEvent` (`PaymentEvent | CardSavedEvent`), with one [status vocabulary](https://sarraf-docs.vercel.app/concepts/statuses/) for every provider. Narrow events with `event.type`, `isPaymentEvent` or `assertPaymentEvent`; name one with `EventOf<"payment.succeeded">`
- **Money:** integer minor units with string math. `toMinor` / `toMajorString` handle 3-decimal KWD/BHD/OMR/JOD. A bare number doesn't compile ([Money](https://sarraf-docs.vercel.app/concepts/money/))
- **Errors:** `SarrafError` with stable `code`s, `provider`, `providerCode`, `retryable` and `docsUrl`. `TIMEOUT_UNKNOWN_OUTCOME` marks money calls that timed out and may have happened ([Errors](https://sarraf-docs.vercel.app/reference/errors/))
- **HTTP:** timeouts; retries only for safe calls (never for money-moving ones); redacted debug logs and hooks
- **Idempotency:** pass `idempotencyKey` to money calls. `MemoryStore` by default, `RedisStore` from `@sarrafjs/core/redis` for more than one server (bring your own ioredis / node-redis client) ([Idempotency](https://sarraf-docs.vercel.app/concepts/idempotency/))
- **Webhooks:** constant-time signature checks over the raw body, stable `event.id` for dedupe ([Webhooks](https://sarraf-docs.vercel.app/concepts/webhooks/))
- **Conformance:** `runConformanceTests()` from `@sarrafjs/core/conformance`, for adapter authors

Server-side only: importing it in a browser throws, so secret keys can't leak into client bundles. Requires Node.js 22+.

> Not affiliated with any payment provider. You use your own provider accounts; money flows customer → provider → you. Part of [Sarraf](https://github.com/muhammedalaa1/sarraf). Apache-2.0.
