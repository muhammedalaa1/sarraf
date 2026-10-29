import type { RawWebhookRequest } from "@sarraf/core";
import type { PaymobTransaction } from "./mappers.js";
import {
  paymobRedirectHmac,
  paymobSubscriptionHmac,
  paymobTokenHmac,
  paymobTransactionHmac,
} from "./signature.js";

/** A realistic successful card transaction, for tests. Override any field. */
export function paymobTransaction(overrides: Partial<PaymobTransaction> = {}): PaymobTransaction {
  return {
    id: 192036465,
    pending: false,
    amount_cents: 25000,
    success: true,
    is_auth: false,
    is_capture: false,
    is_standalone_payment: true,
    is_voided: false,
    is_refunded: false,
    is_3d_secure: true,
    integration_id: 123456,
    profile_id: 98765,
    has_parent_transaction: false,
    order: { id: 217503754, merchant_order_id: "order_8841" },
    created_at: "2026-10-20T13:37:02.118146",
    currency: "EGP",
    source_data: { type: "card", pan: "2346", sub_type: "MasterCard" },
    error_occured: false,
    owner: 302852,
    data: { message: "Approved", txn_response_code: "APPROVED" },
    ...overrides,
  };
}

/** Build a signed transaction-processed callback request, as Paymob would POST it. */
export function signPaymobCallback(obj: PaymobTransaction, hmacSecret: string): RawWebhookRequest {
  const rawBody = JSON.stringify({ type: "TRANSACTION", obj });
  return {
    rawBody,
    headers: { "content-type": "application/json" },
    query: { hmac: paymobTransactionHmac(obj, hmacSecret) },
  };
}

/** Build signed redirect query params. */
export function signPaymobRedirect(
  query: Record<string, string>,
  hmacSecret: string,
): Record<string, string> {
  return { ...query, hmac: paymobRedirectHmac(query, hmacSecret) };
}

/** A card-token callback `obj`, as Paymob sends it after a customer saves a card. */
export function paymobCardToken(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1873,
    token: "e5ad4f6e0e9a40c4b5a1b8f0d27a2c51",
    masked_pan: "xxxx-xxxx-xxxx-2346",
    merchant_id: 302852,
    card_subtype: "MasterCard",
    created_at: "2026-10-20T13:37:05.226145",
    email: "customer@example.com",
    order_id: "217503754",
    user_added: false,
    cardholder_name: "Test Account",
    expiry_month: "01",
    expiry_year: "39",
    ...overrides,
  };
}

/** Build a signed card-token callback request. */
export function signPaymobTokenCallback(obj: Record<string, unknown>, hmacSecret: string): RawWebhookRequest {
  return {
    rawBody: JSON.stringify({ type: "TOKEN", obj }),
    headers: { "content-type": "application/json" },
    query: { hmac: paymobTokenHmac(obj, hmacSecret) },
  };
}

/** Build a signed subscription callback request (the HMAC travels in the body). */
export function signPaymobSubscriptionCallback(
  body: Record<string, unknown>,
  hmacSecret: string,
): RawWebhookRequest {
  return {
    rawBody: JSON.stringify({ ...body, hmac: paymobSubscriptionHmac(body, hmacSecret) }),
    headers: { "content-type": "application/json" },
  };
}
