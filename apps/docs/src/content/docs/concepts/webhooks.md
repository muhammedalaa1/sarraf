---
title: Webhooks
description: Verify over the raw body, acknowledge fast, dedupe on event.id.
sidebar:
  order: 3
---

```ts
const event = await pay.webhooks.verifyAndParse(provider, {
  headers: req.headers,
  rawBody: req.rawBody,     // exact bytes: string or Buffer
  query: req.query,         // Paymob sends its hmac in the query string
});
```

Rules:

1. **Use the raw body.** Re-serialized JSON changes bytes and number formatting, which breaks signatures. Use `rawBody()` from `@sarraf/express`, `await req.text()` in Next.js, or `rawBody: true` in NestJS.
2. **The webhook is the source of truth.** Redirect parameters can be tampered with or never arrive.
3. **Dedupe on `event.id`.** Providers retry. Store processed ids with a unique constraint.
4. **Acknowledge quickly.** Do heavy work asynchronously (enqueue the event).

## Debugging signatures

`pay.webhooks.inspect(provider, req)` never throws. It returns the exact string that was hashed (with no secrets), the expected and received signatures, and a reason. The [sandbox dashboard](/guides/dashboard/) shows the same information for every request it receives.

| Provider | Where the signature is | Algorithm |
|---|---|---|
| Paymob | `?hmac=` query param | HMAC-SHA512 over 20 concatenated fields |
| Kashier | `x-kashier-signature` header | HMAC-SHA256 of `query-string.stringify(sorted signatureKeys)` |
| Fawry | `messageSignature` in body | SHA-256 of concatenated fields + secure key (V2) |
