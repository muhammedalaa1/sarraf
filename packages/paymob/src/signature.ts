import { getPath, hmacHex, safeEqualHex, str } from "@sarraf/core";

/**
 * Fields covered by the transaction-processed callback HMAC, in Paymob's exact order.
 * Note Paymob's spelling `error_occured`.
 */
export const PAYMOB_TRANSACTION_HMAC_FIELDS = [
  "amount_cents",
  "created_at",
  "currency",
  "error_occured",
  "has_parent_transaction",
  "id",
  "integration_id",
  "is_3d_secure",
  "is_auth",
  "is_capture",
  "is_refunded",
  "is_standalone_payment",
  "is_voided",
  "order.id",
  "owner",
  "pending",
  "source_data.pan",
  "source_data.sub_type",
  "source_data.type",
  "success",
] as const;

/**
 * Field names in the redirect (`redirection_url`) query string, same order as the callback.
 * Paymob flattens `order.id` to `order` and keeps the dotted `source_data.*` names. ⚠️ verify.
 */
export const PAYMOB_REDIRECT_HMAC_FIELDS = PAYMOB_TRANSACTION_HMAC_FIELDS.map((f) =>
  f === "order.id" ? "order" : f,
);

/**
 * Values are used as received: booleans become "true"/"false", numbers their plain string.
 * ⚠️ null / missing values become "" (confirm against a real callback fixture).
 */
export function stringifyHmacValue(v: unknown): string {
  return str(v) ?? "";
}

/** The exact string Paymob hashes for a transaction callback `obj`. */
export function paymobSignedString(obj: Record<string, unknown>): string {
  return PAYMOB_TRANSACTION_HMAC_FIELDS.map((path) => stringifyHmacValue(getPath(obj, path))).join("");
}

/** HMAC-SHA512 (lowercase hex) of the transaction callback, keyed with the HMAC secret. */
export function paymobTransactionHmac(obj: Record<string, unknown>, hmacSecret: string): string {
  return hmacHex("sha512", hmacSecret, paymobSignedString(obj));
}

export function verifyPaymobTransactionHmac(
  obj: Record<string, unknown>,
  hmacSecret: string,
  received: string | undefined,
): boolean {
  return safeEqualHex(paymobTransactionHmac(obj, hmacSecret), received);
}

export function paymobRedirectSignedString(query: Record<string, string>): string {
  return PAYMOB_REDIRECT_HMAC_FIELDS.map((k) => query[k] ?? "").join("");
}

export function paymobRedirectHmac(query: Record<string, string>, hmacSecret: string): string {
  return hmacHex("sha512", hmacSecret, paymobRedirectSignedString(query));
}

/** Fields covered by the card-token (`type: "TOKEN"`) callback HMAC, in Paymob's order. */
export const PAYMOB_TOKEN_HMAC_FIELDS = [
  "card_subtype",
  "created_at",
  "email",
  "id",
  "masked_pan",
  "merchant_id",
  "order_id",
  "token",
] as const;

export function paymobTokenSignedString(obj: Record<string, unknown>): string {
  return PAYMOB_TOKEN_HMAC_FIELDS.map((path) => stringifyHmacValue(getPath(obj, path))).join("");
}

/** HMAC-SHA512 (lowercase hex) of a card-token callback `obj`. */
export function paymobTokenHmac(obj: Record<string, unknown>, hmacSecret: string): string {
  return hmacHex("sha512", hmacSecret, paymobTokenSignedString(obj));
}

/** The string a subscription callback signs: `"<trigger_type>for<subscription_data.id>"`. */
export function paymobSubscriptionSignedString(body: Record<string, unknown>): string {
  return `${stringifyHmacValue(body.trigger_type)}for${stringifyHmacValue(getPath(body, "subscription_data.id"))}`;
}

/** HMAC-SHA512 (lowercase hex) of a subscription callback; the result travels in the body's `hmac`. */
export function paymobSubscriptionHmac(body: Record<string, unknown>, hmacSecret: string): string {
  return hmacHex("sha512", hmacSecret, paymobSubscriptionSignedString(body));
}
