# Kashier endpoints used by Sarraf

Hosts (`KASHIER_URLS`, override with `urls`):

| Mode | checkout | api | fep |
|---|---|---|---|
| test | `https://checkout.kashier.io` | `https://test-api.kashier.io` | `https://test-fep.kashier.io` |
| live | `https://checkout.kashier.io` | `https://api.kashier.io` | `https://fep.kashier.io` |

Server auth: `Authorization: <secretKey>` (raw key, no `Bearer`). Sessions also send `api-key: <apiKey>`.

| Operation | Method + URL | Function | Status |
|---|---|---|---|
| Hosted payment page | `GET {checkout}/?merchantId&orderId&amount&currency&hash&mode&merchantRedirect&serverWebhook&allowedMethods&display[&customerReference][&metaData]` | `createCheckout` (flow `hpp`, default) | ✅ sandbox |
| Payment session | `POST {api}/v3/payment/sessions` → `{_id, sessionUrl}` | `createSession` (flow `session`) | 🧪 beta, unrecorded |
| Order lookup | `GET {api}/v3/payment/orders?search=<merchantOrderId>` → `{data: [order…]}` | `findOrder` | ✅ sandbox |
| Refund | `PUT {fep}/v3/orders/{kashierOrderId}` `{apiOperation:"REFUND", reason, transaction:{amount}}` | `refundOrder` | ✅ partial and full |
| Void | `PUT {fep}/v3/orders/{kashierOrderId}` `{apiOperation:"VOID", transaction:{targetTransactionId, amount}}` | `voidOrder` | ✅ same day |

## Hosted page parameters

`allowedMethods` from `KASHIER_METHOD_NAMES`: card → `card`, wallet → `wallet`, installments →
`bank_installments` (beta), bnpl → `valu` (beta). Default `card,wallet`. Override with
`providerOptions.allowedMethods`; extra params (e.g. `brandColor`) via `providerOptions.extraParams`.
`metaData` is JSON. `display` = `locale` (`en`/`ar`).

## Session request (beta)

`expireAt` (ISO), `maxFailureAttempts: 3`, `paymentType: "credit"`, `amount` (major string),
`currency`, `order` (= reference), `merchantRedirect`, `serverWebhook`, `failureRedirect: false`,
`display`, `type: "one-time"`, `allowedMethods`, `merchantId`, `metaData`, `customer{email, reference}`.

## Order lookup response (what the mapper reads)

`orderId` (Kashier id → `providerPaymentId`), `merchantOrderId` (→ `reference`), `status`
(`CAPTURED` even after refunds), `order{amount, currency}`, `totalCapturedAmount`,
`totalRefundedAmount`, `method`, `date`, `lastModifiedDate`, `transactions[]` (each `transactionId`,
`operation` pay/refund/void, `status`, `transactionResponseCode`, `transactionResponseMessage{en,ar}`).
`search` is partial and case-insensitive: `order_1` also matches `order_12`.

## Refund / void response

`{ status, response: { result, status, transactionId, … } }`. `response.result` is the operation's
outcome (`SUCCESS`); `response.status` is the order's new state. Sarraf: refund succeeded when the
outcome is SUCCESS / PARTIALLY_REFUNDED / REFUNDED, pending on PENDING, else failed. Void not SUCCESS
→ `PAYMENT_DECLINED`. Cancel picks the last successful `pay` transaction as `targetTransactionId` and
returns the order re-read after the void (`canceled`).

## Currencies

Configurable; default `["EGP", "USD"]`. The first is the fallback when a payload omits currency.
