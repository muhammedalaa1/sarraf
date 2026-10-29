import {
  asRecord,
  buildEvent,
  type Ctx,
  normalizeHeaders,
  normalizeQuery,
  parseJsonBody,
  type RawWebhookRequest,
  SarrafError,
  type SarrafEvent,
  safeEqualHex,
  str,
  type VerifiedWebhook,
  type WebhookInspection,
} from "@sarrafjs/core";
import { getStatus } from "./client.js";
import type { FawryConfig } from "./config.js";
import { toFawryPayment } from "./mappers.js";
import { type FawryNotificationV2, fawryNotificationSignature } from "./signature.js";

const ALGORITHM =
  "SHA-256(fawryRefNumber + merchantRefNumber + paymentAmount(2dp) + orderAmount(2dp) + orderStatus + paymentMethod + paymentRefrenceNumber + secureKey)";

export function inspectFawryWebhook(cfg: FawryConfig, req: RawWebhookRequest): WebhookInspection {
  let body: unknown;
  try {
    body = parseJsonBody("fawry", req.rawBody);
  } catch {
    return { valid: false, algorithm: ALGORITHM, reason: "body is not valid JSON" };
  }
  const n = asRecord(body) as FawryNotificationV2;
  const received = str(n.messageSignature);
  if (!received) {
    const v1 = n.signature !== undefined || n.FawryRefNo !== undefined;
    return {
      valid: false,
      algorithm: ALGORITHM,
      reason: v1
        ? "this looks like a V1 notification (MD5). V1 is not supported: ask Fawry to enable V2 server notifications"
        : "messageSignature is missing",
    };
  }
  let signed: ReturnType<typeof fawryNotificationSignature>;
  try {
    signed = fawryNotificationSignature(n, cfg.secureKey);
  } catch (err) {
    return { valid: false, algorithm: ALGORITHM, received, reason: `cannot build signature: ${String(err)}` };
  }
  return {
    valid: safeEqualHex(signed.signature, received),
    signedString: `${signed.signedString}<secureKey>`,
    expected: signed.signature,
    received,
    algorithm: ALGORITHM,
  };
}

export function verifyFawryWebhook(cfg: FawryConfig, req: RawWebhookRequest): VerifiedWebhook {
  const inspection = inspectFawryWebhook(cfg, req);
  if (!inspection.valid) {
    throw new SarrafError(
      "WEBHOOK_SIGNATURE_INVALID",
      `fawry notification rejected: ${inspection.reason ?? "messageSignature mismatch (check secureKey and amount formatting)"}`,
      { provider: "fawry" },
    );
  }
  return {
    provider: "fawry",
    body: parseJsonBody("fawry", req.rawBody),
    headers: normalizeHeaders(req.headers),
    query: normalizeQuery(req.query),
  };
}

export async function parseFawryWebhook(
  cfg: FawryConfig,
  verified: VerifiedWebhook,
  ctx: Ctx,
): Promise<SarrafEvent> {
  const n = asRecord(verified.body) as FawryNotificationV2;
  let payment = toFawryPayment(n);
  if (cfg.confirmWithStatusQuery && payment.reference) {
    // Defense in depth: trust the status API over the notification body.
    const confirmed = toFawryPayment({
      ...(await getStatus(cfg, ctx, payment.reference)),
      fawryRefNumber: n.fawryRefNumber,
    });
    if (confirmed.status !== payment.status) {
      ctx.logger.warn("fawry: notification status differs from status query; using the status query", {
        notification: payment.status,
        statusQuery: confirmed.status,
        reference: payment.reference,
      });
    }
    payment = { ...confirmed, raw: { notification: n, status: confirmed.raw } };
  }
  return buildEvent({
    provider: "fawry",
    providerEventId: str(n.fawryRefNumber) ?? str(n.requestId) ?? payment.reference,
    payment,
    receivedAt: ctx.now(),
    raw: verified.body,
  });
}
