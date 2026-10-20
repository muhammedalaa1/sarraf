# @sarraf/core

The core of [Sarraf](https://github.com/sarraf-dev/sarraf): one payment API for Egypt and the Middle East.

```bash
npm i @sarraf/core @sarraf/paymob @sarraf/kashier @sarraf/fawry
```

```ts
import { Sarraf, toMinor } from "@sarraf/core";

const pay = new Sarraf({ providers: { /* paymob(), kashier(), fawry() */ } });
await pay.checkout.create({ provider: "paymob", amount: { value: toMinor("250.00", "EGP"), currency: "EGP" }, /* … */ });
const event = await pay.webhooks.verifyAndParse("paymob", { headers, rawBody, query });
```

- **Models**: `Checkout`, `Payment`, `Refund`, `SarrafEvent`, with one status vocabulary for every provider
- **Money**: integer minor units with string math. `toMinor` / `toMajorString` handle 3-decimal KWD/BHD/OMR/JOD
- **Errors**: `SarrafError` with stable `code`s, including `TIMEOUT_UNKNOWN_OUTCOME` for money calls that timed out
- **HTTP**: timeouts; retries only for safe calls; redacted debug logs and hooks
- **Idempotency**: `MemoryStore` (default), plus `RedisStore` from `@sarraf/core/redis` (bring your own ioredis / node-redis client)
- **Conformance**: `runConformanceTests()` from `@sarraf/core/conformance` for adapter authors

Server-side only: importing it in a browser throws.

> Not affiliated with any payment provider. Part of [Sarraf](https://github.com/sarraf-dev/sarraf). Apache-2.0.
