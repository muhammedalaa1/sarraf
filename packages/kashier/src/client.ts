import { type Ctx, SarrafError, asRecord, ensureOk, str } from "@sarraf/core";
import type { KashierConfig } from "./config.js";

/** Thin wrappers around Kashier server APIs. ⚠️ All endpoints here are beta until confirmed in the sandbox. */

const message = (data: unknown): string | undefined => {
  const d = asRecord(data);
  const m = d.message ?? asRecord(d.response).message ?? d.error;
  return typeof m === "string" ? m : m ? JSON.stringify(m).slice(0, 300) : undefined;
};

function requireSecret(cfg: KashierConfig, what: string): string {
  if (!cfg.secretKey) {
    throw new SarrafError("CONFIGURATION_INVALID", `kashier: secretKey is required for ${what}`, {
      provider: "kashier",
    });
  }
  return cfg.secretKey;
}

export interface KashierSessionRequest {
  expireAt: string;
  maxFailureAttempts: number;
  paymentType: "credit";
  amount: string;
  currency: string;
  order: string;
  merchantRedirect?: string | undefined;
  serverWebhook?: string | undefined;
  failureRedirect?: boolean | undefined;
  display: "en" | "ar";
  type: "one-time";
  allowedMethods: string;
  merchantId: string;
  metaData?: Record<string, string> | undefined;
  customer?: { email?: string; reference?: string } | undefined;
  description?: string | undefined;
}

/** Payment Sessions API (v3). ⚠️ Beta. */
export async function createSession(
  cfg: KashierConfig,
  ctx: Ctx,
  body: KashierSessionRequest,
): Promise<{ _id: string; sessionUrl: string; [k: string]: unknown }> {
  const res = await ctx.http.request<{ _id?: string; sessionUrl?: string }>({
    method: "POST",
    url: `${cfg.urls.api}/v3/payment/sessions`,
    headers: { authorization: requireSecret(cfg, "payment sessions"), "api-key": cfg.apiKey },
    body,
    moneyMoving: true,
    provider: "kashier",
    operation: "kashier.createSession",
  });
  ensureOk(res, "kashier", "createSession", message);
  if (!res.data?.sessionUrl || !res.data._id) {
    throw new SarrafError("PROVIDER_UNAVAILABLE", "kashier createSession returned no sessionUrl", {
      provider: "kashier",
      raw: res.data,
    });
  }
  return res.data as { _id: string; sessionUrl: string };
}

/** Order lookup. ⚠️ Beta: path to confirm. */
export async function getOrder(
  cfg: KashierConfig,
  ctx: Ctx,
  orderId: string,
): Promise<Record<string, unknown>> {
  const res = await ctx.http.request<Record<string, unknown>>({
    method: "GET",
    url: `${cfg.urls.fep}/v3/orders/${encodeURIComponent(orderId)}`,
    headers: { authorization: requireSecret(cfg, "order lookup") },
    provider: "kashier",
    operation: "kashier.getOrder",
  });
  ensureOk(res, "kashier", "getOrder", message);
  const body = asRecord(res.data);
  const response = asRecord(body.response ?? body.data ?? body.body ?? body);
  if (!str(response.merchantOrderId) && !str(response.kashierOrderId) && !str(response.status)) {
    throw new SarrafError("NOT_FOUND", `kashier: order "${orderId}" not found`, {
      provider: "kashier",
      raw: body,
    });
  }
  return response;
}

/** Refund on an order. ⚠️ Beta: body shape from community sources (apiOperation REFUND). */
export async function refundOrder(
  cfg: KashierConfig,
  ctx: Ctx,
  orderId: string,
  amount: string,
  reason?: string,
): Promise<Record<string, unknown>> {
  const res = await ctx.http.request<Record<string, unknown>>({
    method: "PUT",
    url: `${cfg.urls.fep}/v3/orders/${encodeURIComponent(orderId)}/`,
    headers: { authorization: requireSecret(cfg, "refunds") },
    body: { apiOperation: "REFUND", reason: reason ?? "Refund", transaction: { amount: Number(amount) } },
    moneyMoving: true,
    provider: "kashier",
    operation: "kashier.refund",
  });
  ensureOk(res, "kashier", "refund", message);
  return asRecord(res.data);
}
