# @sarraf/testing

Test helpers for [Sarraf](https://github.com/muhammedalaa1/sarraf).

- `fakeProvider(id)`: an in-memory provider. `simulate(reference, status)` returns a signed webhook.
- `createMockFetch(routes)`: a router-based fetch for adapter tests (pass it as `http: { fetch }`)
- `loadFixture(provider, scenario)`: loads scrubbed sandbox fixtures

```ts
const fake = fakeProvider("paymob");
const pay = new Sarraf({ providers: { paymob: fake } });
await pay.checkout.create({ provider: "paymob", reference: "o1", /* … */ });
const event = await pay.webhooks.verifyAndParse("paymob", fake.simulate("o1", "succeeded"));
```

> Not affiliated with any payment provider. Part of [Sarraf](https://github.com/muhammedalaa1/sarraf). Apache-2.0.
