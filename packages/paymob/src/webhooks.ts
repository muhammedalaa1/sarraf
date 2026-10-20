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
  normalizeHeaders,
  normalizeQuery,
  parseJsonBody,
  safeEqualHex,
  str,
} from "@sarraf/core";
import type { PaymobConfig } from "./config.js";
import { type PaymobTransaction, mapPaymobStatus, toPaymobPayment } from "./mappers.js";
import { paymobRedirectHmac, paymobSignedString, paymobTransactionHmac } from "./signature.js";

const ALGORITHM = "HMAC-SHA512(hex) over 20 concatenated transaction fields";

export function inspectPaymobWebhook(cfg: PaymobConfig, req: RawWebhookRequest): WebhookInspection {
  const query = normalizeQuery(req.query);
  const received = query.hmac;
  let body: unknown;
  try {
    body = parseJsonBody("paymob", req.rawBody);
  } catch {
    return { valid: false, algorithm: ALGORITHM, received, reason: "body is not valid JSON" };
  }
  const b = asRecord(body);
  if (b.type && b.type !== "TRANSACTION") {
    return {
      valid: false,
      algorithm: ALGORITHM,
      received,
      reason: `callback type "${str(b.type) ?? "missing"}" is not supported (only TRANSACTION; saved-card TOKEN callbacks are out of scope in v1)`,
    };
  }
  const obj = asRecord(b.obj);
  if (Object.keys(obj).length === 0) {
    return { valid: false, algorithm: ALGORITHM, received, reason: "body.obj is missing" };
  }
  const signedString = paymobSignedString(obj);
  const expected = paymobTransactionHmac(obj, cfg.hmacSecret);
  return {
    valid: safeEqualHex(expected, received),
    signedString,
    expected,
    received,
    algorithm: ALGORITHM,
    reason: received ? undefined : "missing `hmac` query parameter (Paymob sends it on the callback URL)",
  };
}

export function verifyPaymobWebhook(cfg: PaymobConfig, req: RawWebhookRequest): VerifiedWebhook {
  const inspection = inspectPaymobWebhook(cfg, req);
  if (!inspection.valid) {
    throw new SarrafError(
      "WEBHOOK_SIGNATURE_INVALID",
      `paymob callback rejected: ${inspection.reason ?? "HMAC mismatch (check hmacSecret and that the body is the raw request body)"}`,
      { provider: "paymob" },
    );
  }
  return {
    provider: "paymob",
    body: parseJsonBody("paymob", req.rawBody),
    headers: normalizeHeaders(req.headers),
    query: normalizeQuery(req.query),
  };
}

export function parsePaymobWebhook(cfg: PaymobConfig, verified: VerifiedWebhook, ctx: Ctx): SarrafEvent {
  const txn = asRecord(asRecord(verified.body).obj) as PaymobTransaction;
  const payment = toPaymobPayment(txn, cfg.currency);
  const isRefundTxn = txn.is_refund === true;
  return buildEvent({
    provider: "paymob",
    providerEventId: txn.id,
    payment,
    type: isRefundTxn ? (txn.success ? "refund.succeeded" : "refund.failed") : undefined,
    receivedAt: ctx.now(),
    raw: verified.body,
  });
}

/**
 * Redirect params are for the thank-you page only. Paymob may append an `hmac` over the same
 * field set; when it is present and matches, `authenticated` is true. ⚠️ verify with a fixture.
 */
export function verifyPaymobRedirect(cfg: PaymobConfig, query: Record<string, string>): RedirectResult {
  const authenticated =
    typeof query.hmac === "string" && safeEqualHex(paymobRedirectHmac(query, cfg.hmacSecret), query.hmac);
  const amount = { value: Number(query.amount_cents) || 0, currency: cfg.currency };
  const hasStatus = query.success !== undefined || query.pending !== undefined;
  const status = hasStatus
    ? mapPaymobStatus(
        {
          success: query.success === "true",
          pending: query.pending === "true",
          is_voided: query.is_voided === "true",
          is_refunded: query.is_refunded === "true",
        },
        amount,
      )
    : "unknown";
  return {
    provider: "paymob",
    authenticated,
    status,
    reference: str(query.merchant_order_id),
    providerPaymentId: str(query.id),
    raw: query,
  };
}
