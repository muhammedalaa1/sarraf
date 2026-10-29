import { SarrafError } from "./errors.js";
import type { HeaderValue, ProviderId, RawWebhookRequest } from "./types.js";

export function normalizeHeaders(headers: RawWebhookRequest["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (typeof (headers as Headers).forEach === "function" && typeof (headers as Headers).get === "function") {
    (headers as Headers).forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
    return out;
  }
  for (const [k, v] of Object.entries(headers as Record<string, HeaderValue>)) {
    const value = first(v);
    if (value !== undefined) out[k.toLowerCase()] = value;
  }
  return out;
}

export function normalizeQuery(query: RawWebhookRequest["query"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query ?? {})) {
    const value = first(v);
    if (value !== undefined) out[k] = value;
  }
  return out;
}

export function rawBodyToString(rawBody: RawWebhookRequest["rawBody"]): string {
  if (typeof rawBody === "string") return rawBody;
  if (rawBody instanceof Uint8Array) return new TextDecoder("utf-8").decode(rawBody);
  throw new SarrafError(
    "INVALID_REQUEST",
    "Webhook rawBody must be the raw request body (string or Buffer). Use the rawBody() middleware from @sarrafjs/express.",
  );
}

export function parseJsonBody(provider: ProviderId, rawBody: RawWebhookRequest["rawBody"]): unknown {
  const text = rawBodyToString(rawBody);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new SarrafError("WEBHOOK_SIGNATURE_INVALID", `${provider} webhook body is not valid JSON`, {
      provider,
      cause: err,
    });
  }
}

/** Read a dotted path such as "order.id" from an object. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Stringify a scalar (string, number, boolean, bigint). Returns `undefined` for null, undefined,
 * objects and arrays, so a nested object can never be signed or stored as "[object Object]".
 */
export function str(value: unknown): string | undefined {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    default:
      return undefined;
  }
}

function first(v: HeaderValue): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
