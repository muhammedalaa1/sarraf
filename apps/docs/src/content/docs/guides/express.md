---
title: Express
description: Webhooks and checkout with Express.
sidebar:
  order: 1
---

```ts
import express from "express";
import { rawBody, webhookHandler } from "@sarraf/express";
import { pay } from "./pay";

const app = express();

// 1. Webhooks FIRST, with rawBody() instead of express.json()
app.post(
  "/api/webhooks/:provider",
  rawBody(),
  webhookHandler(pay, async (event) => {
    await db.events.insertIgnoreDuplicate({ id: event.id });   // dedupe
    await db.orders.update(event.payment.reference, { status: event.payment.status });
  }),
);

// 2. Then your normal JSON routes
app.use(express.json());
app.post("/checkout", async (req, res) => {
  const checkout = await pay.checkout.create({ provider: req.body.provider, /* … */ });
  res.json({ url: checkout.redirectUrl, code: checkout.referenceCode });
});
```

`webhookHandler` answers:

| Situation | HTTP |
|---|---|
| Verified and your handler succeeded | 200 |
| Invalid signature | 400 |
| Unknown provider in the URL | 404 |
| Your handler threw (`handle-first`, the default) | 500, so the provider retries |

Use `{ mode: "ack-first" }` to answer 200 before your handler runs. Only do that if your handler just enqueues the event.

Full example: [`examples/express-shop`](https://github.com/muhammedalaa1/sarraf/tree/main/examples/express-shop).
