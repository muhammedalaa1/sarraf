import {
  type Ctx,
  type RawWebhookRequest,
  type RedirectResult,
  SarrafError,
  type SarrafEvent,
  type VerifiedWebhook,
  type WebhookInspection,
  asRecord,
  buildEvent,
  isCurrency,
  normalizeHeaders,
  normalizeQuery,
  parseJsonBody,
  safeEqualHex,
  str,
  toMinor,
} from "@sarraf/core";
import type { KashierConfig } from "./config.js";
import { type KashierTransactionData, mapKashierStatus, toKashierPayment } from "./mappers.js";
import {
  type QueryInput,
  kashierRedirectSignature,
  kashierWebhookSignature,
  kashierWebhookSignedString,
} from "./signature.js";

export const KASHIER_SIGNATURE_HEADER = "x-kashier-signature";
const ALGORITHM =
  "HMAC-SHA256(hex) of query-string.stringify(sorted signatureKeys), keyed with the Payment API key";

export function inspectKashierWebhook(cfg: KashierConfig, req: RawWebhookRequest): WebhookInspection {
  const received = normalizeHeaders(req.headers)[KASHIER_SIGNATURE_HEADER];
  let body: unknown;
  try {
    body = parseJsonBody("kashier", req.rawBody);
  } catch {
    return { valid: false, algorithm: ALGORITHM, received, reason: "body is not valid JSON" };
  }
  const data = asRecord(asRecord(body).data);
  if (!Array.isArray(data.signatureKeys) || data.signatureKeys.length === 0) {
    return { valid: false, algorithm: ALGORITHM, received, reason: "data.signatureKeys is missing" };
  }
  const signedString = kashierWebhookSignedString(data);
  const expected = kashierWebhookSignature(data, cfg.apiKey);
  return {
    valid: safeEqualHex(expected, received),
    signedString,
    expected,
    received,
    algorithm: ALGORITHM,
    reason: received ? undefined : `missing ${KASHIER_SIGNATURE_HEADER} header`,
  };
}

export function verifyKashierWebhook(cfg: KashierConfig, req: RawWebhookRequest): VerifiedWebhook {
  const inspection = inspectKashierWebhook(cfg, req);
  if (!inspection.valid) {
    throw new SarrafError(
      "WEBHOOK_SIGNATURE_INVALID",
      `kashier webhook rejected: ${inspection.reason ?? "signature mismatch (check the Payment API key, and that you pass the raw body)"}`,
      { provider: "kashier" },
    );
  }
  return {
    provider: "kashier",
    body: parseJsonBody("kashier", req.rawBody),
    headers: normalizeHeaders(req.headers),
    query: normalizeQuery(req.query),
  };
}

export function parseKashierWebhook(cfg: KashierConfig, verified: VerifiedWebhook, ctx: Ctx): SarrafEvent {
  const body = asRecord(verified.body);
  const event = str(body.event) ?? "pay";
  const data = asRecord(body.data) as KashierTransactionData;
  const payment = toKashierPayment(data, event, cfg.currencies[0] ?? "EGP");
  const isRefund = event.toLowerCase() === "refund";
  return buildEvent({
    provider: "kashier",
    providerEventId: `${str(data.transactionId) ?? payment.providerPaymentId}${isRefund ? ":refund" : ""}`,
    payment,
    type: isRefund ? (payment.status === "failed" ? "refund.failed" : "refund.succeeded") : undefined,
    receivedAt: ctx.now(),
    raw: verified.body,
  });
}

/** Verify `merchantRedirect` query params. UX only: the webhook is the source of truth. */
export function verifyKashierRedirectParams(cfg: KashierConfig, query: QueryInput): RedirectResult {
  const pairs: [string, string][] =
    typeof query === "string"
      ? [...new URLSearchParams(query.replace(/^\?/, ""))]
      : Array.isArray(query)
        ? query
        : Object.entries(query);
  const q = Object.fromEntries(pairs);
  const authenticated = safeEqualHex(kashierRedirectSignature(pairs, cfg.apiKey), q.signature);
  const currency = isCurrency(q.currency) ? q.currency : (cfg.currencies[0] ?? "EGP");
  let amountMinor = 0;
  try {
    amountMinor = q.amount ? toMinor(q.amount, currency) : 0;
  } catch {
    amountMinor = 0;
  }
  return {
    provider: "kashier",
    authenticated,
    status: q.paymentStatus
      ? mapKashierStatus("pay", q.paymentStatus, { amount: { value: amountMinor, currency } })
      : "unknown",
    reference: q.merchantOrderId,
    providerPaymentId: q.orderId ?? q.transactionId,
    raw: q,
  };
}
