# Paymob flows in Sarraf

## Integration ids (`integrationIds`, env `PAYMOB_<NAME>_INTEGRATION_ID`)

| Key | Env name | Offered on default checkout | Purpose |
|---|---|---|---|
| `card` | CARD | yes | 3DS card |
| `wallet` | WALLET | yes | Mobile wallets (EGY) |
| `apple_pay` | APPLE_PAY | yes, with `card` | Apple Pay (live ids only) |
| `bnpl` | BNPL | yes | valU, Souhoola, Sympl, Aman installments… (KSA/UAE: Tabby, Tamara) |
| `installments` | INSTALLMENTS | yes | Bank installments (live ids only) |
| `cash_outlet` | KIOSK | no — only `methods: ["cash_outlet"]` | Kiosk bill reference |
| `card_auth` | CARD_AUTH | no — only `capture: "manual"` | Auth-mode card |
| `card_moto` | CARD_MOTO | no | MOTO: saved-card charges, subscription renewals |

`integrationIdsFor()` in adapter.ts resolves `methods` → ids; unknown → `CAPABILITY_NOT_SUPPORTED`.
`providerOptions.paymentMethods` bypasses this with raw ids/names.

## Checkout variants

| Variant | How | Result |
|---|---|---|
| Hosted redirect | `checkout.create({ provider: "paymob", … })` | `kind:"redirect"`, Unified Checkout URL, `payment.status:"pending"`, `providerPaymentId:""` |
| Pixel (embedded) | same, then `paymobEmbed(checkout)` → `{publicKey, clientSecret}` for the browser | Pixel options (`showSaveCard`, `forceSaveCard`, Apple/Google Pay) are client-side |
| Kiosk | `methods: ["cash_outlet"]` (alone) | intention on kiosk id → `payWithSource(AGGREGATOR)` → `kind:"reference_code"`, `referenceCode = data.bill_reference`, status `awaiting_payment`, `providerPaymentId` = txn id |
| Manual capture | `providerOptions: { capture: "manual" }` (card only) | intention on `card_auth`; webhook → `requires_action`; then `payments.capture` |
| Saved card, customer present | `providerOptions: { cardTokens: [token] }` | card offered on the checkout (needs 3DS/Auth/Card-on-file integration) |
| Saved card, merchant initiated | `extras.cards.charge({ token, reference, amount, customer, idempotencyKey })` | intention on `card_moto` → `payWithSource(TOKEN)` → `Payment` |
| Subscription | `extras.subscriptions.plans.create` then `extras.subscriptions.create({ planId, … })` | checkout for the first 3DS payment; Paymob renews on the plan's MOTO integration |
| Add subscription card | `extras.subscriptions.cards.add(subId, checkoutInput)` | checkout with `subscriptionv2_id` |
| Payment link | `extras.links.create({ amount, reference, methods, expiresAt, … })` | `{ id, url, shortUrl, state }`; payment arrives as a TRANSACTION callback |

There is no "save card" flag on the intention: the customer ticks it on the checkout (or Pixel
`showSaveCard`), and the card arrives as a TOKEN callback.

## Money operations

- `refunds.create`: partial sends the amount; full (no amount) re-reads the txn (needs `apiKey`),
  refuses kiosk payments and fully refunded ones, refunds the remainder. `refund.payment` = re-read
  payment when `apiKey` is set. `reference`/`reason` aren't sent (Paymob doesn't take them).
- `payments.cancel`: void by `providerPaymentId`, or resolves it from `reference` via the inquiry.
  A void Paymob refuses → `PAYMENT_DECLINED` with `data.message`.
- `payments.capture`: amount defaults to the authorized amount (needs `apiKey`); returns the payment
  keyed on the *original* auth id, status `succeeded`. ⚠️ Whether later refunds should target the
  auth txn or the capture txn is unconfirmed.

## Status mapping (mapPaymobStatus, order matters)

1. `is_voided`/`is_void` → `canceled`
2. `is_refund` (refund txn) → `refunded`
3. `pending` → `awaiting_payment` for kiosk (`source_data.type` aggregator), else `pending`
4. `success` + `is_auth` + not `is_capture` + `captured_amount` 0 → `requires_action`
5. `success` + `is_refunded` → `partially_refunded` / `refunded` from `refunded_amount_cents`
6. `success` → `succeeded`
7. otherwise → `failed` (`failure.message = data.message`, `providerCode = data.txn_response_code`)

`expired` is never produced: Paymob doesn't mark expiry in a transaction. Methods
(`mapPaymobMethod`): card/apple_pay/google_pay → card; wallet; aggregator/kiosk/cash_present →
cash_outlet; bank_installment → installments; BNPL lender names → bnpl; other.

Capability levels today: card, wallet, getPayment (with apiKey), refund, partialRefund, cancel,
webhooks, redirects = supported; cash_outlet, bnpl, installments, capture (with card_auth) = beta.
