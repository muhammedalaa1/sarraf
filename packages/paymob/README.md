# @sarraf/paymob

Paymob adapter for [Sarraf](https://github.com/sarraf-dev/sarraf).

```ts
import { paymob } from "@sarraf/paymob";

paymob({
  region: "egypt",                      // egypt | ksa | uae | oman
  secretKey: process.env.PAYMOB_SECRET_KEY!,
  publicKey: process.env.PAYMOB_PUBLIC_KEY!,
  hmacSecret: process.env.PAYMOB_HMAC_SECRET!,
  apiKey: process.env.PAYMOB_API_KEY,   // needed for getPayment / reconcile
  integrationIds: { card: 123456, wallet: 654321 },
});
```

- Checkout: Intention API → Unified Checkout URL (`client_secret` is single-use)
- Webhooks: HMAC-SHA512 over Paymob's 20 transaction fields, with `hmac` in the callback query string
- Status: transaction inquiry using the legacy auth token, cached ~50 minutes
- Refund (full or partial) and same-day void
- Test helpers: `@sarraf/paymob/testing` (`paymobTransaction`, `signPaymobCallback`)

> Not affiliated with any payment provider. Part of [Sarraf](https://github.com/sarraf-dev/sarraf). Apache-2.0.
