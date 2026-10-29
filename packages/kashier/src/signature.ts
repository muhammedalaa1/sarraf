import { hmacHex, safeEqualHex } from "@sarrafjs/core";
import queryString from "query-string";

export interface KashierOrderHashInput {
  merchantId: string;
  orderId: string;
  /** Major-unit amount string, exactly as it will appear in the checkout URL. */
  amount: string;
  currency: string;
  /** Optional saved-card customer reference. ⚠️ */
  customerReference?: string | undefined;
}

/** The path string Kashier hashes for the hosted payment page (format from Kashier's official demo). */
export function kashierOrderHashPath(input: KashierOrderHashInput): string {
  const base = `/?payment=${input.merchantId}.${input.orderId}.${input.amount}.${input.currency}`;
  return input.customerReference ? `${base}.${input.customerReference}` : base;
}

/** HMAC-SHA256 (hex) of the order path, keyed with the Payment API key. */
export function kashierOrderHash(input: KashierOrderHashInput, apiKey: string): string {
  return hmacHex("sha256", apiKey, kashierOrderHashPath(input));
}

export type QueryInput = Record<string, string> | [string, string][] | string;

function entries(query: QueryInput): [string, string][] {
  if (typeof query === "string") return [...new URLSearchParams(query.replace(/^\?/, ""))];
  return Array.isArray(query) ? query : Object.entries(query);
}

/**
 * The string Kashier signs on `merchantRedirect`: every query param except `signature` and
 * `mode`, in the order received, as `key=value` joined with `&` (decoded values).
 */
export function kashierRedirectSignedString(query: QueryInput): string {
  return entries(query)
    .filter(([k]) => k !== "signature" && k !== "mode")
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

export function kashierRedirectSignature(query: QueryInput, apiKey: string): string {
  return hmacHex("sha256", apiKey, kashierRedirectSignedString(query));
}

export function verifyKashierRedirect(query: QueryInput, apiKey: string): boolean {
  const received = entries(query).find(([k]) => k === "signature")?.[1];
  return safeEqualHex(kashierRedirectSignature(query, apiKey), received);
}

/**
 * The payload Kashier signs on webhooks: `data.signatureKeys` sorted, picked from `data`, and
 * serialized exactly like the `query-string` library's `stringify` (strict RFC 3986 encoding,
 * arrays as repeated keys, null as a bare key). Plain encodeURIComponent breaks on `* ( ) ' !`.
 */
export function kashierWebhookSignedString(data: Record<string, unknown>): string {
  const keys = Array.isArray(data.signatureKeys) ? [...(data.signatureKeys as string[])].sort() : [];
  const picked = Object.fromEntries(keys.map((k) => [k, data[k]]));
  return queryString.stringify(picked as Record<string, string>);
}

export function kashierWebhookSignature(data: Record<string, unknown>, apiKey: string): string {
  return hmacHex("sha256", apiKey, kashierWebhookSignedString(data));
}

export function verifyKashierWebhookSignature(
  data: Record<string, unknown>,
  apiKey: string,
  received: string | undefined,
): boolean {
  return safeEqualHex(kashierWebhookSignature(data, apiKey), received);
}
