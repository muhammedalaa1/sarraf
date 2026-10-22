# @sarrafjs/express

Express helpers for [Sarraf](https://github.com/muhammedalaa1/Sarraf).

```ts
import { rawBody, webhookHandler } from "@sarrafjs/express";

app.post("/api/webhooks/:provider", rawBody(), webhookHandler(pay, async (event) => {
  await queue.add("payment-event", event, { jobId: event.id }); // dedupe on event.id
}));
```

- `rawBody()` keeps the exact bytes on `req.rawBody`, which signatures need. Use it *instead of* `express.json()` on webhook routes.
- `webhookHandler()` answers 400 for invalid signatures, 404 for unknown providers, and 500 when your handler throws, so the provider retries. `mode: "ack-first"` answers 200 before running your handler.

> Not affiliated with any payment provider. Part of [Sarraf](https://github.com/muhammedalaa1/Sarraf). Apache-2.0.
