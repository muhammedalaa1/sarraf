---
title: Next.js
description: Route handlers, thank-you pages and server actions with the App Router.
sidebar:
  order: 3
---

```bash
npm install @sarrafjs/next
```

Keep Sarraf on the server and out of client bundles:

```js
// next.config.mjs
export default {
  serverExternalPackages: ["@sarrafjs/core", "@sarrafjs/next", "@sarrafjs/paymob", "@sarrafjs/kashier", "@sarrafjs/fawry"],
};
```

## Webhooks

`app/api/webhooks/[provider]/route.ts`:

```ts
import { webhookRoute } from "@sarrafjs/next";
import { pay } from "@/lib/pay";

export const runtime = "nodejs";

export const POST = webhookRoute(pay, async (event) => {
  await applyEvent(event); // dedupe on event.id
});
```

`webhookRoute` reads the exact body with `req.text()`, verifies the signature and calls your handler with the normalized `SarrafEvent`. It answers:

| Status | When |
|---|---|
| 200 | Verified, and your handler finished |
| 400 | `WEBHOOK_SIGNATURE_INVALID` |
| 404 | The `[provider]` segment is not a configured provider |
| 500 | Processing failed, or your handler threw, so the provider retries |

Options:

- `provider: "paymob"` for a fixed route such as `app/api/webhooks/paymob/route.ts`, or `param` for a segment with another name.
- `defer: after` (from `next/server`) answers 200 as soon as the signature is valid and runs your handler after the response. Errors are then only logged, so use it to enqueue work, not to do it.
- `pay` can also be a function, e.g. `webhookRoute(() => getPay(), onEvent)`, for clients created on first use.

## Thank-you page

```tsx
// app/thanks/[provider]/page.tsx
import { verifyRedirect } from "@sarrafjs/next";

export default async function Thanks({ params, searchParams }) {
  const { provider } = await params;
  const result = await verifyRedirect(pay, provider, searchParams);
  if (result.authenticated && result.status === "failed") return <TryAgain />;
  return <ThankYou reference={result.reference} />;
}
```

Redirects are for the message only: never fulfil an order from them. `verifyRedirect` returns `authenticated: false, status: "unknown"` for providers that don't sign redirects (Fawry) instead of throwing.

## Checkout from a server action

```ts
"use server";
export async function checkout(formData: FormData) {
  const result = await pay.checkout.create({ provider: "kashier", /* … */ });
  redirect(result.redirectUrl!);
}
```

`@sarrafjs/next` only uses the Fetch API `Request` / `Response`, so `webhookRoute` also works in other Fetch-based frameworks (Hono, Remix, Bun).

Full example: [`examples/nextjs-shop`](https://github.com/muhammedalaa1/sarraf/tree/main/examples/nextjs-shop).
