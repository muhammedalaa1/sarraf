# @sarrafjs/paymob

Paymob adapter for [Sarraf](https://github.com/muhammedalaa1/sarraf).

```ts
import { paymob, paymobIntegrationIdsFromEnv } from "@sarrafjs/paymob";

paymob({
  region: "egypt",                      // egypt | ksa | uae | oman
  secretKey: process.env.PAYMOB_SECRET_KEY!,
  publicKey: process.env.PAYMOB_PUBLIC_KEY!,
  hmacSecret: process.env.PAYMOB_HMAC_SECRET!,
  apiKey: process.env.PAYMOB_API_KEY,   // lookups, full refunds, subscriptions, links
  integrationIds: paymobIntegrationIdsFromEnv(process.env), // or { card: 123456, wallet: 654321, … }
});
```

- Checkout: Intention API → Unified Checkout URL (`client_secret` is single-use), or a kiosk bill reference with `methods: ["cash_outlet"]`
- Manual capture: `providerOptions: { capture: "manual" }`, then `pay.payments.capture(...)`
- Webhooks: HMAC-SHA512 over Paymob's 20 transaction fields (or 8 card-token fields), with `hmac` in the callback query string. Saved cards arrive as `card.saved` events
- Status: transaction inquiry using the API-key auth token, cached ~50 minutes
- Refund (full or partial), same-day void by transaction id or reference
- Paymob-only APIs on `pay.provider("paymob").extras`: saved-card charges (MOTO), subscriptions and plans, payment links, intention update / retrieve
- Test helpers: `@sarrafjs/paymob/testing` (`paymobTransaction`, `signPaymobCallback`, `signPaymobTokenCallback`, `signPaymobSubscriptionCallback`)

Full guide: [sarraf.dev/providers/paymob](https://sarraf.dev/providers/paymob).

> Not affiliated with any payment provider. Part of [Sarraf](https://github.com/muhammedalaa1/sarraf). Apache-2.0.
