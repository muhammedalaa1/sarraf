# @sarrafjs/next

Next.js (App Router) helpers for [Sarraf](https://github.com/muhammedalaa1/sarraf).

📖 **Docs:** [Next.js guide](https://sarraf-docs.vercel.app/guides/nextjs/) · [Accept payments with Paymob](https://sarraf-docs.vercel.app/guides/paymob/) · [with Kashier](https://sarraf-docs.vercel.app/guides/kashier/)

```bash
npm i @sarrafjs/core @sarrafjs/next
```

```ts
// app/api/webhooks/[provider]/route.ts
import { webhookRoute } from "@sarrafjs/next";
import { pay } from "@/lib/pay";

export const runtime = "nodejs";

export const POST = webhookRoute(pay, async (event) => {
  if (event.type === "card.saved") return; // Paymob saved card: no payment
  await markOrder(event.payment.reference, event.payment.status); // dedupe on event.id
});
```

```tsx
// app/thanks/[provider]/page.tsx: UX only, the webhook decides the order status
import { verifyRedirect } from "@sarrafjs/next";

export default async function Thanks({ params, searchParams }) {
  const { provider } = await params;
  const result = await verifyRedirect(pay, provider, searchParams);
  return result.authenticated && result.status === "failed" ? <TryAgain /> : <ThankYou />;
}
```

- `webhookRoute()` reads the exact body with `req.text()`, then answers 404 for unknown providers, 400 for invalid signatures, and 500 when your handler throws, so the provider retries.
- Pass `defer: after` (from `next/server`) to answer 200 before your handler runs. Only do that if the handler just enqueues work.
- `pay` can be a client or a function returning one, for clients created on first use.
- `verifyRedirect()` never throws for providers that don't sign redirects (Fawry). It returns `authenticated: false`.
- Only the Fetch API `Request` / `Response` is used, so it works in other Fetch-based frameworks too.

Requires Node.js 22+.

> Not affiliated with any payment provider. Part of [Sarraf](https://github.com/muhammedalaa1/sarraf). Apache-2.0.
