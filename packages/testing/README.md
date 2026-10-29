# @sarrafjs/testing

Test helpers for [Sarraf](https://github.com/muhammedalaa1/sarraf).

📖 **Docs:** [Testing your integration](https://sarraf-docs.vercel.app/guides/testing/) · [All docs](https://sarraf-docs.vercel.app/)

```bash
npm i -D @sarrafjs/testing
```

- `fakeProvider(id)`: an in-memory provider. `simulate(reference, status)` returns a signed webhook.
- `createMockFetch(routes)`: a router-based fetch for adapter tests (pass it as `http: { fetch }`)
- `loadFixture(provider, scenario)`: loads scrubbed sandbox fixtures

```ts
const fake = fakeProvider("paymob");
const pay = new Sarraf({ providers: { paymob: fake } });
await pay.checkout.create({ provider: "paymob", reference: "o1", /* … */ });
const event = await pay.webhooks.verifyAndParse("paymob", fake.simulate("o1", "succeeded"));
```

Use it in tests only. Requires Node.js 22+.

> Not affiliated with any payment provider. Part of [Sarraf](https://github.com/muhammedalaa1/sarraf). Apache-2.0.
