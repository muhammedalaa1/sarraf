import { asRecord, type Ctx, ensureOk, SarrafError, str } from "@sarrafjs/core";
import type { PaymobConfig } from "./config.js";
import type { PaymobTransaction } from "./mappers.js";

/** Thin typed wrappers around Paymob endpoints. No normalization here. */

export interface PaymobIntentionRequest {
  amount: number;
  currency: string;
  payment_methods: (number | string)[];
  items: { name: string; amount: number; quantity: number; description?: string | undefined }[];
  billing_data: {
    first_name: string;
    last_name: string;
    email: string;
    phone_number: string;
    [k: string]: string;
  };
  special_reference: string;
  notification_url?: string | undefined;
  redirection_url?: string | undefined;
  expiration?: number | undefined;
  extras?: Record<string, unknown> | undefined;
}

export interface PaymobIntentionResponse {
  id: string;
  intention_order_id?: number | undefined;
  client_secret: string;
  status?: string | undefined;
  payment_methods?: unknown[] | undefined;
  [k: string]: unknown;
}

const message = (data: unknown): string | undefined => {
  const d = asRecord(data);
  return (
    str(d.detail) ?? str(d.message) ?? (Object.keys(d).length ? JSON.stringify(d).slice(0, 300) : undefined)
  );
};

export async function createIntention(
  cfg: PaymobConfig,
  ctx: Ctx,
  body: PaymobIntentionRequest,
): Promise<PaymobIntentionResponse> {
  const res = await ctx.http.request<PaymobIntentionResponse>({
    method: "POST",
    url: `${cfg.baseUrl}/v1/intention/`,
    headers: { authorization: `Token ${cfg.secretKey}` },
    body,
    moneyMoving: true,
    provider: "paymob",
    operation: "paymob.createIntention",
  });
  ensureOk(res, "paymob", "createIntention", message);
  if (!res.data?.client_secret) {
    throw new SarrafError("PROVIDER_UNAVAILABLE", "paymob createIntention returned no client_secret", {
      provider: "paymob",
      raw: res.data,
    });
  }
  return res.data;
}

export function unifiedCheckoutUrl(cfg: PaymobConfig, clientSecret: string): string {
  const u = new URL(`${cfg.baseUrl}/unifiedcheckout/`);
  u.searchParams.set("publicKey", cfg.publicKey);
  u.searchParams.set("clientSecret", clientSecret);
  return u.toString();
}

/** Short-lived auth token from the legacy API key, cached for ~50 minutes per adapter instance. */
export class PaymobTokenCache {
  private token: { value: string; expiresAt: number } | undefined;

  async get(cfg: PaymobConfig, ctx: Ctx): Promise<string> {
    if (!cfg.apiKey) {
      throw new SarrafError(
        "CONFIGURATION_INVALID",
        "paymob: apiKey is required for transaction inquiry (getPayment / reconcile). Find it in Settings → Account info.",
        { provider: "paymob" },
      );
    }
    const now = ctx.now().getTime();
    if (this.token && this.token.expiresAt > now) return this.token.value;
    const res = await ctx.http.request<{ token?: string }>({
      method: "POST",
      url: `${cfg.baseUrl}/api/auth/tokens`,
      body: { api_key: cfg.apiKey },
      retryable: true,
      provider: "paymob",
      operation: "paymob.authToken",
    });
    ensureOk(res, "paymob", "authToken", message);
    const token = res.data?.token;
    if (!token)
      throw new SarrafError("AUTHENTICATION_FAILED", "paymob auth returned no token", { provider: "paymob" });
    this.token = { value: token, expiresAt: now + 50 * 60 * 1000 };
    return token;
  }

  clear(): void {
    this.token = undefined;
  }
}

export async function getTransaction(
  cfg: PaymobConfig,
  ctx: Ctx,
  tokens: PaymobTokenCache,
  transactionId: string,
): Promise<PaymobTransaction> {
  const token = await tokens.get(cfg, ctx);
  const res = await ctx.http.request<PaymobTransaction>({
    method: "GET",
    url: `${cfg.baseUrl}/api/acceptance/transactions/${encodeURIComponent(transactionId)}`,
    query: { token },
    provider: "paymob",
    operation: "paymob.getTransaction",
  });
  if (res.status === 401) tokens.clear();
  ensureOk(res, "paymob", "getTransaction", message);
  return res.data;
}

/**
 * Inquiry by merchant order id. ⚠️ The path and auth vary by account; confirm in the Postman
 * collection. Returns the latest transaction for the order.
 */
export async function getTransactionByReference(
  cfg: PaymobConfig,
  ctx: Ctx,
  tokens: PaymobTokenCache,
  reference: string,
): Promise<PaymobTransaction> {
  const token = await tokens.get(cfg, ctx);
  const res = await ctx.http.request<PaymobTransaction | PaymobTransaction[]>({
    method: "POST",
    url: `${cfg.baseUrl}/api/ecommerce/orders/transaction_inquiry`,
    headers: { authorization: `Bearer ${token}` },
    body: { merchant_order_id: reference },
    retryable: true,
    provider: "paymob",
    operation: "paymob.transactionInquiry",
  });
  if (res.status === 401) tokens.clear();
  ensureOk(res, "paymob", "transactionInquiry", message);
  const data = Array.isArray(res.data) ? res.data[res.data.length - 1] : res.data;
  if (!data || typeof data.id !== "number") {
    throw new SarrafError("NOT_FOUND", `paymob: no transaction for reference "${reference}"`, {
      provider: "paymob",
    });
  }
  return data;
}

export async function refundTransaction(
  cfg: PaymobConfig,
  ctx: Ctx,
  transactionId: string,
  amountCents: number,
): Promise<PaymobTransaction> {
  const res = await ctx.http.request<PaymobTransaction>({
    method: "POST",
    url: `${cfg.baseUrl}/api/acceptance/void_refund/refund`,
    headers: { authorization: `Token ${cfg.secretKey}` },
    body: { transaction_id: toId(transactionId), amount_cents: amountCents },
    moneyMoving: true,
    provider: "paymob",
    operation: "paymob.refund",
  });
  ensureOk(res, "paymob", "refund", message);
  return res.data;
}

export async function voidTransaction(
  cfg: PaymobConfig,
  ctx: Ctx,
  transactionId: string,
): Promise<PaymobTransaction> {
  const res = await ctx.http.request<PaymobTransaction>({
    method: "POST",
    url: `${cfg.baseUrl}/api/acceptance/void_refund/void`,
    headers: { authorization: `Token ${cfg.secretKey}` },
    body: { transaction_id: toId(transactionId) },
    moneyMoving: true,
    provider: "paymob",
    operation: "paymob.void",
  });
  ensureOk(res, "paymob", "void", message);
  return res.data;
}

function toId(id: string): number {
  const n = Number(id);
  if (!Number.isSafeInteger(n)) {
    throw new SarrafError("INVALID_REQUEST", `paymob transaction id must be numeric (got "${id}")`, {
      provider: "paymob",
    });
  }
  return n;
}
