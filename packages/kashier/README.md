# @sarraf/kashier

Kashier adapter for [Sarraf](https://github.com/sarraf-dev/sarraf).

```ts
import { kashier } from "@sarraf/kashier";

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
- Beta (`allowBeta: true`): Payment Sessions flow (`providerOptions: { flow: "session" }`), order lookup, refunds

> Not affiliated with any payment provider. Part of [Sarraf](https://github.com/sarraf-dev/sarraf). Apache-2.0.
