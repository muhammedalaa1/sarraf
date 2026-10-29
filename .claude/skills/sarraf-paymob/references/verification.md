# Paymob verification state

Update this file whenever a fixture is recorded or a doc claim turns out wrong. It is how the next
session knows what it can trust.

## Status (2026-10-28)

No real sandbox exchanges recorded yet. `fixtures/paymob/callback-{succeeded,declined,partially-refunded,null-fields}.json`
are synthetic (`"source": "synthetic"`). All Paymob unit tests run against `createMockFetch` with
shapes taken from Paymob's docs and Postman collections.

| Claim | Basis | Confidence |
|---|---|---|
| Intention create body/response, `Token sk_` auth | docs + Postman | high |
| Transaction HMAC field list and order | docs (with sample string) | high |
| `null` → `""` in HMAC | inferred | ⚠️ confirm with `callback-null-fields`-like real callback |
| Redirect HMAC uses `order` (not `order.id`/`order_id`) | inferred | ⚠️ |
| Token HMAC field list | docs | medium |
| Subscription HMAC `"<trigger>for<id>"` in body | docs | medium |
| Lookup by id with Bearer header | docs | medium (old code used `?token=`) |
| Reference inquiry: body `auth_token` + Bearer | docs vs Postman disagree; sending both | medium |
| Refund/void response = new txn with `parent_transaction` | docs/Postman | medium |
| Kiosk: pay with `AGGREGATOR` source → `data.bill_reference` | community SDKs, not current docs | ⚠️ low |
| MOTO charge via `payments/pay` with `subtype:"TOKEN"` | docs (MIT page) | medium |
| Capture response = capture txn | docs | ⚠️ which id to refund afterwards |
| Payment links multipart fields | docs | medium |
| Region-specific checkout hosts (`eg.checkout.paymob.com`) | docs; Postman uses `/unifiedcheckout/` | not switched |

## How to verify

1. Fill the Paymob block of `.env.sandbox` (see `.env.sandbox.example`): test secret/public keys,
   HMAC secret, API key, integration ids (card, wallet, kiosk, card_auth, card_moto).
2. Tunnel: `pnpm record-fixtures webhook` (port 4545) + `cloudflared tunnel --url http://localhost:4545`;
   set `SANDBOX_PUBLIC_URL`; set the integration's webhook/redirect URLs in the Paymob dashboard to
   `<tunnel>/webhooks/paymob` and `<tunnel>/return/paymob`.
3. Record:
   - `pnpm record-fixtures checkout paymob` → pay with `5123456789012346` (01/39, 123), tick "save card"
     to also get a TOKEN callback.
   - `pnpm record-fixtures checkout paymob --method wallet|cash_outlet`, `--capture manual`
   - `pnpm record-fixtures status paymob <txnId|reference>`
   - `pnpm record-fixtures refund paymob <txnId> 3.00` and without amount
   - `pnpm record-fixtures cancel paymob <reference>` (same day)
   - `pnpm record-fixtures capture paymob <authTxnId> [amount]`
   - `pnpm record-fixtures charge paymob <cardToken>`, `pnpm record-fixtures link paymob`
4. Each webhook is verified with the real secret first (`verifiedAgainstRealSignature`), then
   scrubbed and re-signed with `test_hmac_secret_do_not_use`. Rename the auto-numbered
   `sandbox-webhook-*-<n>.json` you want to keep.
5. Turn fixtures into tests (signature tests + adapter tests using `loadFixture`), set rows in
   `PAYMOB_STATUS_TABLE` to `verified: true` with the fixture path, move capabilities from beta to
   supported, replace the synthetic callbacks, and update this table.
6. `pnpm test:sandbox` runs `tests/sandbox/contract.test.ts` (intention, update/retrieve, kiosk,
   links, capture with `PAYMOB_SANDBOX_AUTH_TRANSACTION_ID`, lookup with `PAYMOB_SANDBOX_TRANSACTION_ID`).
