import {
  asRecord,
  buildEvent,
  type Ctx,
  isCurrency,
  normalizeHeaders,
  normalizeQuery,
  type Payment,
  parseJsonBody,
  type RawWebhookRequest,
  type RedirectResult,
  SarrafError,
  type SarrafEvent,
  safeEqualHex,
  str,
  toMinor,
  type VerifiedWebhook,
  type WebhookInspection,
} from "@sarrafjs/core";
import { findOrder } from "./client.js";
import type { KashierConfig } from "./config.js";
import {
  type KashierTransactionData,
  mapKashierStatus,
  toKashierOrderPayment,
  toKashierPayment,
} from "./mappers.js";
import {
  kashierRedirectSignature,
  kashierWebhookSignature,
  kashierWebhookSignedString,
  type QueryInput,
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

export async function parseKashierWebhook(
  cfg: KashierConfig,
  verified: VerifiedWebhook,
  ctx: Ctx,
): Promise<SarrafEvent> {
  const body = asRecord(verified.body);
  const event = str(body.event) ?? "pay";
  const data = asRecord(body.data) as KashierTransactionData;
  const fromWebhook = toKashierPayment(data, event, cfg.currencies[0] ?? "EGP");
  const isRefund = event.toLowerCase() === "refund";
  const refundFailed = isRefund && fromWebhook.status === "failed";
  const payment = isRefund && !refundFailed ? await withOrderTotals(cfg, ctx, fromWebhook) : fromWebhook;
  return buildEvent({
    provider: "kashier",
    providerEventId: `${str(data.transactionId) ?? payment.providerPaymentId}${isRefund ? ":refund" : ""}`,
    payment,
    type: isRefund ? (refundFailed ? "refund.failed" : "refund.succeeded") : undefined,
    receivedAt: ctx.now(),
    raw: verified.body,
  });
}

/**
 * Kashier's refund webhook carries only the refund amount, not the order total or what was refunded
 * before (fixtures/kashier/sandbox-webhook-refund-partial.json), so it cannot say whether the order
 * is now partially or fully refunded. Read the totals from the order lookup instead.
 */
async function withOrderTotals(cfg: KashierConfig, ctx: Ctx, payment: Payment): Promise<Payment> {
  if (!cfg.secretKey || !payment.reference) {
    ctx.logger.warn(
      "kashier: refund webhook without order totals. Configure secretKey so Sarraf can look the order up; until then payment.status and payment.amount describe only this refund.",
      { reference: payment.reference },
    );
    return payment;
  }
  const order = toKashierOrderPayment(
    await findOrder(cfg, ctx, payment.reference),
    cfg.currencies[0] ?? "EGP",
  );
  return { ...order, card: payment.card, raw: payment.raw };
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
