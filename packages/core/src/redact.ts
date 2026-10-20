const SECRET_KEY =
  /(secret|token|password|passwd|signature|hmac|authorization|api[-_]?key|apikey|secure[-_]?key|cvv|cvc|card[-_]?number|^pan$|^hash$|client[-_]?secret)/i;
/** Keys that look sensitive but only carry field names. */
const ALLOWED_KEYS = new Set(["signatureKeys", "signature_keys"]);
const EMAIL_KEY = /(e-?mail|customerMail)/i;
const PHONE_KEY = /(phone|mobile|msisdn)/i;
const EMAIL_VALUE = /[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+/g;

export const REDACTED = "[REDACTED]";

export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return REDACTED;
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return REDACTED;
  return `***${digits.slice(-2)}`;
}

export function isSensitiveKey(key: string): boolean {
  return !ALLOWED_KEYS.has(key) && SECRET_KEY.test(key);
}

/** Deep-copy `value` with secrets removed and emails / phones masked. Safe to log. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 20) return REDACTED as T;
  if (typeof value === "string") return redactString(value) as T;
  if (Array.isArray(value)) return (value as unknown[]).map((v) => redact(v, depth + 1)) as T;
  if (value && typeof value === "object") {
    if (value instanceof Date) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactEntry(k, v, depth);
    }
    return out as T;
  }
  return value;
}

function redactEntry(key: string, value: unknown, depth: number): unknown {
  if (value === null || value === undefined || value === "") return value;
  if (isSensitiveKey(key)) return REDACTED;
  if (typeof value === "string" || typeof value === "number") {
    if (EMAIL_KEY.test(key)) return maskEmail(String(value));
    if (PHONE_KEY.test(key)) return maskPhone(String(value));
  }
  return redact(value, depth + 1);
}

function redactString(s: string): string {
  if (/^https?:\/\//i.test(s)) return redactUrl(s);
  return s.replace(EMAIL_VALUE, (m) => maskEmail(m));
}

/** Redact sensitive query parameters in a URL. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (isSensitiveKey(key) || /^(publicKey|clientSecret|hash|token)$/i.test(key)) {
        u.searchParams.set(key, REDACTED);
      } else if (EMAIL_KEY.test(key)) {
        u.searchParams.set(key, maskEmail(u.searchParams.get(key) ?? ""));
      } else if (PHONE_KEY.test(key)) {
        u.searchParams.set(key, maskPhone(u.searchParams.get(key) ?? ""));
      }
    }
    return u.toString();
  } catch {
    return url;
  }
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = isSensitiveKey(k) ? REDACTED : v;
  return out;
}
