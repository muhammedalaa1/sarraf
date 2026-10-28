import {
  asRecord,
  buildEvent,
  type Ctx,
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
  type VerifiedWebhook,
  type WebhookInspection,
} from "@sarraf/core";
import type { PaymobConfig } from "./config.js";
import { mapPaymobStatus, type PaymobTransaction, toPaymobPayment, toSavedCard, truthy } from "./mappers.js";
import {
  paymobRedirectHmac,
  paymobSignedString,
  paymobTokenHmac,
  paymobTokenSignedString,
  paymobTransactionHmac,
} from "./signature.js";

const ALGORITHM = "HMAC-SHA512(hex) over 20 concatenated transaction fields";
const TOKEN_ALGORITHM = "HMAC-SHA512(hex) over 8 concatenated card-token fields";

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
  const type = b.type === undefined ? "TRANSACTION" : str(b.type);
  if (type !== "TRANSACTION" && type !== "TOKEN") {
    return {
      valid: false,
      algorithm: ALGORITHM,
      received,
      reason: `callback type "${type ?? "missing"}" is not supported (TRANSACTION or TOKEN; subscription callbacks go to extras.subscriptions.verifyWebhook)`,
    };
  }
  const algorithm = type === "TOKEN" ? TOKEN_ALGORITHM : ALGORITHM;
  const obj = asRecord(b.obj);
  if (Object.keys(obj).length === 0) {
    return { valid: false, algorithm, received, reason: "body.obj is missing" };
  }
  const signedString = type === "TOKEN" ? paymobTokenSignedString(obj) : paymobSignedString(obj);
  const expected =
    type === "TOKEN" ? paymobTokenHmac(obj, cfg.hmacSecret) : paymobTransactionHmac(obj, cfg.hmacSecret);
  return {
    valid: safeEqualHex(expected, received),
    signedString,
    expected,
    received,
    algorithm,
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

/** Reads a transaction by id. Given when the adapter has an `apiKey`. */
export type PaymobLookup = (transactionId: string) => Promise<Payment>;

export async function parsePaymobWebhook(
  cfg: PaymobConfig,
  verified: VerifiedWebhook,
  ctx: Ctx,
  lookup?: PaymobLookup,
): Promise<SarrafEvent> {
  const body = asRecord(verified.body);
  const obj = asRecord(body.obj);
  if (body.type === "TOKEN") return cardSavedEvent(obj, ctx, verified.body);

  const txn = obj as PaymobTransaction;
  let payment = toPaymobPayment(txn, cfg.currency);
  const isRefundTxn = truthy(txn.is_refund);
  const parentId = str(txn.parent_transaction);
  if (isRefundTxn && parentId && lookup) {
    // A refund callback describes the refund transaction. Report the original payment with its totals.
    try {
      payment = await lookup(parentId);
    } catch (err) {
      ctx.logger.warn("paymob: could not read the refunded payment; reporting the refund transaction", {
        parentTransaction: parentId,
        error: String(err),
      });
    }
  }
  return buildEvent({
    provider: "paymob",
    providerEventId: txn.id,
    payment,
    type: isRefundTxn ? (txn.success ? "refund.succeeded" : "refund.failed") : undefined,
    receivedAt: ctx.now(),
    raw: verified.body,
  });
}

function cardSavedEvent(obj: Record<string, unknown>, ctx: Ctx, raw: unknown): SarrafEvent {
  const card = toSavedCard(obj);
  return {
    id: `paymob:${str(obj.id) ?? card.token}:card.saved`,
    type: "card.saved",
    provider: "paymob",
    card,
    providerOrderId: str(obj.order_id),
    receivedAt: ctx.now().toISOString(),
    raw,
  };
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
