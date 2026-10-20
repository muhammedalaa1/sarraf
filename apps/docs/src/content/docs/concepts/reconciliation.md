---
title: Reconciliation
description: Recover from lost webhooks.
sidebar:
  order: 5
---

Webhooks get lost: deploys, timeouts, misconfigured URLs. Run a scheduled job:

```ts
// every 5 minutes
for (const order of await orders.findPendingOlderThan({ minutes: 15 })) {
  const payment = await pay.payments.reconcile({ provider: order.provider, reference: order.reference });
  if (payment.status !== order.status) await orders.update(order.id, { status: payment.status });
}
```

- **Paymob** needs `apiKey` for transaction inquiry.
- **Fawry** looks up by merchant reference (status v2). Reference codes can take hours or days to be paid, so keep checking until `expiresAt`.
- **Kashier** order lookup is beta (`allowBeta: true`).
