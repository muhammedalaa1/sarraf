---
title: Testing your integration
description: Fake providers, signed test webhooks and fixtures.
sidebar:
  order: 4
---

## Fake provider

```ts
import { Sarraf } from "@sarrafjs/core";
import { fakeProvider } from "@sarrafjs/testing";

const fake = fakeProvider("paymob");                 // stands in for any provider id
const pay = new Sarraf({ providers: { paymob: fake } });

await pay.checkout.create({ provider: "paymob", reference: "o1", /* … */ });
const webhook = fake.simulate("o1", "succeeded");    // correctly signed request
const event = await pay.webhooks.verifyAndParse("paymob", webhook);
```

## Real adapters with signed test webhooks

Each adapter ships helpers under `/testing`:

```ts
import { paymobTransaction, signPaymobCallback } from "@sarrafjs/paymob/testing";
import { kashierWebhookData, signKashierWebhook } from "@sarrafjs/kashier/testing";
import { fawryNotification, signFawryNotification } from "@sarrafjs/fawry/testing";

const req = signPaymobCallback(paymobTransaction({ success: false }), process.env.TEST_HMAC!);
```

## Mock HTTP

```ts
import { createMockFetch } from "@sarrafjs/testing";

const fetch = createMockFetch([
  { method: "POST", url: "/v1/intention/", respond: { status: 201, body: { id: "pi_1", client_secret: "cs" } } },
]);
const pay = new Sarraf({ providers, http: { fetch } });
```

## Contributing adapters

Every adapter must pass `runConformanceTests()` from `@sarrafjs/core/conformance`. See [CONTRIBUTING](https://github.com/muhammedalaa1/Sarraf/blob/main/CONTRIBUTING.md).
