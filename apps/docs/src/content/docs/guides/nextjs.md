---
title: Next.js
description: Route handlers and server actions with the App Router.
sidebar:
  order: 3
---

Keep Sarraf on the server and out of client bundles:

```js
// next.config.mjs
export default {
  serverExternalPackages: ["@sarraf/core", "@sarraf/paymob", "@sarraf/kashier", "@sarraf/fawry"],
};
```

Webhook route handler, `app/api/webhooks/[provider]/route.ts`:

```ts
export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  try {
    const event = await pay.webhooks.verifyAndParse(provider as ProviderId, {
      headers: req.headers,
      rawBody: await req.text(),                       // exact body
      query: Object.fromEntries(new URL(req.url).searchParams),
    });
    await applyEvent(event);                           // dedupe on event.id
    return Response.json({ received: true });
  } catch (err) {
    if (isSarrafError(err, "WEBHOOK_SIGNATURE_INVALID")) return new Response(null, { status: 400 });
    return new Response(null, { status: 500 });
  }
}
```

Checkout from a server action:

```ts
"use server";
export async function checkout(formData: FormData) {
  const result = await pay.checkout.create({ provider: "kashier", /* … */ });
  redirect(result.redirectUrl!);
}
```

Full example: [`examples/nextjs-shop`](https://github.com/sarraf-dev/sarraf/tree/main/examples/nextjs-shop).
