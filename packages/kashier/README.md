# @sarrafjs/kashier

Kashier adapter for [Sarraf](https://github.com/muhammedalaa1/Sarraf).

```ts
import { kashier } from "@sarrafjs/kashier";

kashier({
  merchantId: process.env.KASHIER_MID!,
  apiKey: process.env.KASHIER_API_KEY!,      // Payment API key: hashes and signatures
  secretKey: process.env.KASHIER_SECRET_KEY, // server APIs (beta)
  mode: "test",
});
```

- Checkout: signed hosted payment page (the same amount string is used in the hash and the URL)
- Webhooks: `x-kashier-signature`, HMAC-SHA256 of the sorted `signatureKeys`, serialized exactly like `query-string`
- Redirect verification over the query params (excluding `signature` and `mode`), in the order received
- Order lookup by your reference, and full / partial refunds (need `secretKey`; a full refund also needs `reference`)
- Refund webhooks report the real order totals, read from the order lookup
- Same-day voids with `payments.cancel({ provider: "kashier", reference })`
- Beta (`allowBeta: true`): Payment Sessions flow (`providerOptions: { flow: "session" }`)

> Not affiliated with any payment provider. Part of [Sarraf](https://github.com/muhammedalaa1/Sarraf). Apache-2.0.
