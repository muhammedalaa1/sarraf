---
title: Payment statuses
description: One status vocabulary for every provider.
sidebar:
  order: 2
---

| Status | Meaning |
|---|---|
| `pending` | Created; the customer has not finished paying, or the provider is still processing |
| `requires_action` | Authorized but needs another step (e.g. capture) |
| `awaiting_payment` | A reference code was issued; waiting for cash payment (Fawry) |
| `succeeded` | Paid |
| `failed` | Declined or errored. See `payment.failure` |
| `canceled` | Voided or canceled |
| `expired` | Reference or checkout expired unpaid |
| `refunded` / `partially_refunded` | Money returned |

Each adapter exports its mapping table (`PAYMOB_STATUS_TABLE`, `KASHIER_STATUS_TABLE`, `FAWRY_STATUS_TABLE`). The dashboard's **Status explorer** renders them. Rows marked "to verify" are waiting on a recorded sandbox fixture.

## Events

Webhooks become a `SarrafEvent`:

```ts
{
  id: "paymob:192036465:succeeded",   // stable dedupe key
  type: "payment.succeeded",          // payment.failed | payment.pending | payment.expired | payment.canceled | refund.succeeded | refund.failed
  provider: "paymob",
  payment: { /* normalized Payment */ },
  receivedAt: "2026-10-20T13:37:02.000Z",
  raw: { /* provider payload */ }
}
```
