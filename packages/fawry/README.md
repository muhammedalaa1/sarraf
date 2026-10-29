# @sarraf/fawry

Fawry adapter for [Sarraf](https://github.com/muhammedalaa1/sarraf).

```ts
import { fawry } from "@sarraf/fawry";

fawry({
  merchantCode: process.env.FAWRY_MERCHANT_CODE!,
  secureKey: process.env.FAWRY_SECURE_KEY!,
  environment: "staging",
  confirmWithStatusQuery: true, // default: re-query status after a valid notification
});
```

- Checkout: PayAtFawry reference codes (`checkout.kind === "reference_code"`, `status: "awaiting_payment"`)
- Signatures: plain SHA-256, one function per endpoint, with amounts always written to 2 decimals
- Notifications: V2 `messageSignature` (V1/MD5 is rejected with an explanation)
- Status v2 by merchant reference
- Beta: hosted card/wallet checkout, refund, cancel unpaid reference

> Not affiliated with any payment provider. Part of [Sarraf](https://github.com/muhammedalaa1/sarraf). Apache-2.0.
