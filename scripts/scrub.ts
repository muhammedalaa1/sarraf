/**
 * Scrub recorded sandbox payloads before they are committed as fixtures: secrets, tokens,
 * emails, phones and card numbers are replaced with deterministic placeholders so the
 * structure (and field types) stay intact.
 */

const SECRET_KEYS =
  /^(secret|secretKey|secret_key|api_key|apiKey|token|auth_token|client_secret|hmac|hash|signature|messageSignature|authorization|secureKey|cardDataToken|password)$/i;
const EMAIL_KEYS = /(e-?mail|customerMail)/i;
const PHONE_KEYS = /(phone|mobile|msisdn)/i;
const PAN_KEYS = /^(pan|maskedCard|card_number|cardNumber)$/i;
const EMAIL = /[^\s@"']+@[^\s@"']+\.[A-Za-z]{2,}/g;

export interface ScrubOptions {
  /** Field names to keep verbatim (e.g. a signature you will recompute anyway). */
  keep?: string[] | undefined;
}

export function scrub<T>(value: T, options: ScrubOptions = {}, key = ""): T {
  const keep = new Set(options.keep ?? []);
  if (keep.has(key)) return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, options)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrub(v, options, k)]),
    ) as T;
  }
  if (typeof value !== "string" && typeof value !== "number") return value;
  if (key === "signatureKeys") return value;
  if (SECRET_KEYS.test(key)) return (typeof value === "string" ? "REDACTED" : 0) as T;
  if (EMAIL_KEYS.test(key)) return "customer@example.com" as T;
  if (PHONE_KEYS.test(key)) return (String(value).startsWith("+") ? "+201000000000" : "01000000000") as T;
  if (PAN_KEYS.test(key)) {
    return (String(value).length <= 4 ? "1111" : "411111******1111") as T;
  }
  if (typeof value === "string") {
    return value
      .replace(EMAIL, "customer@example.com")
      .replace(/\b(sk|pk)_(test|live)_[A-Za-z0-9]+/g, "$1_$2_REDACTED") as T;
  }
  return value;
}

/** Remove sensitive query params (hmac, token, publicKey…) from a URL string. */
export function scrubUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (SECRET_KEYS.test(k) || /^(publicKey|clientSecret|token)$/i.test(k))
        u.searchParams.set(k, "REDACTED");
    }
    return u.toString();
  } catch {
    return url;
  }
}
