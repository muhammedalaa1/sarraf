/**
 * Scrub recorded sandbox payloads before they are committed as fixtures: secrets, tokens,
 * emails, phones and card numbers are replaced with deterministic placeholders so the
 * structure (and field types) stay intact.
 */

const SECRET_KEYS =
  /^(secret|secretKey|secret_key|api_key|apiKey|apiKeyId|token|auth_token|client_secret|hmac|hash|signature|messageSignature|authorization|secureKey|password)$|token$/i;
const NAME_KEYS = /^(nameOnCard|cardHolderName|cardholderName|card_holder_name)$/i;
const MERCHANT_KEYS = /^(merchantId|merchant_id|merchantCode|selectedMID)$/i;
// Dashboard users recorded on operations, e.g. Kashier's metaData.kashier_user.fullName on a void.
const PERSON_KEYS = /^(fullName|full_name|userName|user_name)$/i;
const KASHIER_MID = /\bMID-\d+-\d+\b/g;
const STORE_KEYS = /^(storeName|merchantName|businessName)$/i;
// Masked card numbers wherever they appear, e.g. Kashier's paymentMethod.card.number.
const MASKED_PAN = /\b\d{4,8}\*{2,}\d{4}\b/g;
// Your temporary tunnel host (SANDBOX_PUBLIC_URL), echoed back by providers.
const TUNNEL = /https:\/\/[a-z0-9-]+\.(?:trycloudflare\.com|ngrok(?:-free)?\.(?:app|io|dev))/gi;
const EMAIL_KEYS = /(e-?mail|customerMail)/i;
const PHONE_KEYS = /(phone|mobile|msisdn)/i;
const PAN_KEYS = /^(pan|maskedCard|extendedMaskedCard|card_number|cardNumber)$/i;
// e.g. Kashier's metaData.termsAndConditions.ip: the customer's (or your own) public IP.
const IP_KEYS = /^(ip|ipAddress|ip_address|clientIp|customerIp)$/i;
const IP = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
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
  if (NAME_KEYS.test(key)) return "Test Cardholder" as T;
  if (MERCHANT_KEYS.test(key)) return "MERCHANT_ID" as T;
  if (PERSON_KEYS.test(key)) return "Test User" as T;
  if (STORE_KEYS.test(key)) return "Test Store" as T;
  if (IP_KEYS.test(key)) return "203.0.113.1" as T; // TEST-NET-3, never routable
  if (PHONE_KEYS.test(key)) return (String(value).startsWith("+") ? "+201000000000" : "01000000000") as T;
  if (PAN_KEYS.test(key)) {
    return (String(value).length <= 4 ? "1111" : "411111******1111") as T;
  }
  if (typeof value === "string") {
    return value
      .replace(EMAIL, "customer@example.com")
      .replace(IP, "203.0.113.1")
      .replace(MASKED_PAN, "411111******1111")
      .replace(TUNNEL, "https://example.com")
      .replace(KASHIER_MID, "MERCHANT_ID")
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
