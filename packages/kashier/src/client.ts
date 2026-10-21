import { asRecord, type Ctx, ensureOk, SarrafError, str } from "@sarraf/core";
import type { KashierConfig } from "./config.js";

/** Thin wrappers around Kashier server APIs. Each one says whether it is confirmed in the sandbox. */

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

/**
 * Order lookup by your reference: GET {api}/v3/payment/orders?search=<merchantOrderId>. `search` is a
 * partial, case-insensitive match, so the exact order is picked here; `order_1` must not return
 * `order_12`. Confirmed against the sandbox (fixtures/kashier/sandbox-order-partially-refunded.json).
 */
export async function findOrder(
  cfg: KashierConfig,
  ctx: Ctx,
  merchantOrderId: string,
): Promise<Record<string, unknown>> {
  const res = await ctx.http.request<Record<string, unknown>>({
    method: "GET",
    url: `${cfg.urls.api}/v3/payment/orders`,
    query: { search: merchantOrderId },
    headers: { authorization: requireSecret(cfg, "order lookup") },
    provider: "kashier",
    operation: "kashier.findOrder",
  });
  ensureOk(res, "kashier", "findOrder", message);
  const body = asRecord(res.data);
  const orders = Array.isArray(body.data) ? body.data.map(asRecord) : [];
  const order = orders.find((o) => str(o.merchantOrderId) === merchantOrderId);
  if (!order) {
    throw new SarrafError("NOT_FOUND", `kashier: no order with merchantOrderId "${merchantOrderId}"`, {
      provider: "kashier",
    });
  }
  return order;
}

/**
 * Refund on an order: PUT /v3/orders/:orderId with apiOperation REFUND. Confirmed against the
 * sandbox (fixtures/kashier/sandbox-refund-partial-succeeded.json). Always send an amount: the docs
 * call it optional, but the sandbox answers HTTP 500 without one, also on a fresh order: with
 * `transaction: {}`, with no `transaction`, and with only `transaction.targetTransactionId`
 * (sandbox-refund-full-no-amount.json, sandbox-refund-full-target-transaction.json).
 */
export async function refundOrder(
  cfg: KashierConfig,
  ctx: Ctx,
  orderId: string,
  amount: string,
  reason?: string,
): Promise<Record<string, unknown>> {
  const res = await ctx.http.request<Record<string, unknown>>({
    method: "PUT",
    url: `${cfg.urls.fep}/v3/orders/${encodeURIComponent(orderId)}`,
    headers: { authorization: requireSecret(cfg, "refunds") },
    body: { apiOperation: "REFUND", reason: reason ?? "Refund", transaction: { amount: Number(amount) } },
    moneyMoving: true,
    provider: "kashier",
    operation: "kashier.refund",
  });
  ensureOk(res, "kashier", "refund", message);
  return asRecord(res.data);
}

/**
 * Void a transaction on an order: PUT /v3/orders/:orderId with apiOperation VOID. Confirmed in the
 * sandbox (fixtures/kashier/sandbox-void-succeeded.json). The docs
 * call `transaction` optional, but refunds without an amount fail with HTTP 500 in the sandbox, so
 * the target transaction and the amount are always sent. Pay transactions void only on the same day.
 */
export async function voidOrder(
  cfg: KashierConfig,
  ctx: Ctx,
  orderId: string,
  targetTransactionId: string,
  amount: string,
): Promise<Record<string, unknown>> {
  const res = await ctx.http.request<Record<string, unknown>>({
    method: "PUT",
    url: `${cfg.urls.fep}/v3/orders/${encodeURIComponent(orderId)}`,
    headers: { authorization: requireSecret(cfg, "voids") },
    body: { apiOperation: "VOID", transaction: { targetTransactionId, amount: Number(amount) } },
    moneyMoving: true,
    provider: "kashier",
    operation: "kashier.void",
  });
  ensureOk(res, "kashier", "void", message);
  return asRecord(res.data);
}
