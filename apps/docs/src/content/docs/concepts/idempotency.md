---
title: Idempotency & retries
description: Never charge twice.
sidebar:
  order: 4
---

Pass an `idempotencyKey` to `checkout.create` and `refunds.create`. A repeated call with the same key returns the stored result without calling the provider again. Reusing a key with **different** parameters throws `INVALID_REQUEST`.

```ts
await pay.checkout.create({ ...input, idempotencyKey: `checkout:${order.id}:${attempt}` });
```

The default store is in memory. With more than one server instance, use Redis:

```ts
import Redis from "ioredis";
import { RedisStore } from "@sarraf/core/redis";

new Sarraf({ providers, idempotency: new RedisStore(new Redis(process.env.REDIS_URL)) });
```

## Timeouts on money-moving calls

Sarraf **never retries** create, refund or void calls automatically. If one times out, it throws `TIMEOUT_UNKNOWN_OUTCOME`: the provider may or may not have processed it. Query the status (`pay.payments.get`) before you try again. The idempotency key stays locked so that a blind retry cannot double-charge.

Read-only calls (status, inquiry) are retried on network errors, 429 and 5xx, with backoff that respects `Retry-After`.
