import { asRecord, type Ctx, ensureOk, type HttpRequest, SarrafError, str } from "@sarrafjs/core";
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
  /** Saved card tokens offered on the checkout (max 3). */
  card_tokens?: string[] | undefined;
  subscription_plan_id?: number | undefined;
  /** `YYYY-MM-DD`. Omit to start the subscription now. */
  subscription_start_date?: string | undefined;
  /** Adds a secondary card to this subscription instead of charging. */
  subscriptionv2_id?: number | undefined;
}

export interface PaymobPaymentKey {
  integration: number;
  key: string;
  gateway_type?: string | undefined;
  iframe_id?: number | null | undefined;
  order_id?: number | undefined;
}

export interface PaymobIntentionResponse {
  id: string;
  intention_order_id?: number | undefined;
  client_secret: string;
  status?: string | undefined;
  payment_methods?: unknown[] | undefined;
  payment_keys?: PaymobPaymentKey[] | undefined;
  [k: string]: unknown;
}

/** `POST /api/acceptance/payments/pay` source: a saved card token, or the kiosk aggregator. */
export type PaymobPaySource =
  | { identifier: string; subtype: "TOKEN" }
  | { identifier: "AGGREGATOR"; subtype: "AGGREGATOR" };

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

/** Update an unpaid intention. Paymob requires its order id (`intention_order_id`). */
export async function updateIntention(
  cfg: PaymobConfig,
  ctx: Ctx,
  clientSecret: string,
  body: Partial<PaymobIntentionRequest> & { accept_order_id: number },
): Promise<PaymobIntentionResponse> {
  const res = await ctx.http.request<PaymobIntentionResponse>({
    method: "PUT",
    url: `${cfg.baseUrl}/v1/intention/${encodeURIComponent(clientSecret)}/`,
    headers: { authorization: `Token ${cfg.secretKey}` },
    body,
    provider: "paymob",
    operation: "paymob.updateIntention",
  });
  ensureOk(res, "paymob", "updateIntention", message);
  return res.data;
}

/** Read an intention with the public key; no secret needed. */
export async function retrieveIntention(
  cfg: PaymobConfig,
  ctx: Ctx,
  clientSecret: string,
): Promise<PaymobIntentionResponse> {
  const res = await ctx.http.request<PaymobIntentionResponse>({
    method: "GET",
    url: `${cfg.baseUrl}/v1/intention/element/${encodeURIComponent(cfg.publicKey)}/${encodeURIComponent(clientSecret)}/`,
    provider: "paymob",
    operation: "paymob.retrieveIntention",
  });
  ensureOk(res, "paymob", "retrieveIntention", message);
  return res.data;
}

/** Server-side pay with a payment key: charge a saved card (MOTO) or issue a kiosk reference. */
export async function payWithSource(
  cfg: PaymobConfig,
  ctx: Ctx,
  paymentToken: string,
  source: PaymobPaySource,
): Promise<PaymobTransaction> {
  const operation = source.subtype === "TOKEN" ? "payWithToken" : "payKiosk";
  const res = await ctx.http.request<PaymobTransaction>({
    method: "POST",
    url: `${cfg.baseUrl}/api/acceptance/payments/pay`,
    body: { source, payment_token: paymentToken },
    moneyMoving: true,
    provider: "paymob",
    operation: `paymob.${operation}`,
  });
  ensureOk(res, "paymob", operation, message);
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
  return authedRequest<PaymobTransaction>(cfg, ctx, tokens, {
    method: "GET",
    url: `${cfg.baseUrl}/api/acceptance/transactions/${encodeURIComponent(transactionId)}`,
    operation: "getTransaction",
  });
}

/**
 * Inquiry by merchant order id (`special_reference`). Returns the latest transaction for the order.
 * The docs put `auth_token` in the body and the Postman collection uses a Bearer header; send both.
 */
export async function getTransactionByReference(
  cfg: PaymobConfig,
  ctx: Ctx,
  tokens: PaymobTokenCache,
  reference: string,
): Promise<PaymobTransaction> {
  const res = await authedRequest<PaymobTransaction | PaymobTransaction[]>(cfg, ctx, tokens, {
    method: "POST",
    url: `${cfg.baseUrl}/api/ecommerce/orders/transaction_inquiry`,
    body: (token: string) => ({ auth_token: token, merchant_order_id: reference }),
    retryable: true,
    operation: "transactionInquiry",
  });
  const data = Array.isArray(res) ? res[res.length - 1] : res;
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

export async function captureTransaction(
  cfg: PaymobConfig,
  ctx: Ctx,
  transactionId: string,
  amountCents: number,
): Promise<PaymobTransaction> {
  const res = await ctx.http.request<PaymobTransaction>({
    method: "POST",
    url: `${cfg.baseUrl}/api/acceptance/capture`,
    headers: { authorization: `Token ${cfg.secretKey}` },
    body: { transaction_id: toId(transactionId), amount_cents: amountCents },
    moneyMoving: true,
    provider: "paymob",
    operation: "paymob.capture",
  });
  ensureOk(res, "paymob", "capture", message);
  return res.data;
}

export interface AuthedRequest {
  method: HttpRequest["method"];
  url: string;
  query?: HttpRequest["query"];
  /** JSON or form body. A function receives the auth token, for endpoints that want it in the body. */
  body?: unknown;
  retryable?: boolean | undefined;
  moneyMoving?: boolean | undefined;
  /** Logged as `paymob.<operation>`. */
  operation: string;
}

/**
 * A call authenticated with the API-key token (`Authorization: Bearer`). On 401 it drops the cached
 * token and, unless the call moves money, retries once with a fresh one.
 */
export async function authedRequest<T>(
  cfg: PaymobConfig,
  ctx: Ctx,
  tokens: PaymobTokenCache,
  req: AuthedRequest,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const token = await tokens.get(cfg, ctx);
    const res = await ctx.http.request<T>({
      method: req.method,
      url: req.url,
      query: req.query,
      headers: { authorization: `Bearer ${token}` },
      body: typeof req.body === "function" ? (req.body as (t: string) => unknown)(token) : req.body,
      retryable: req.retryable,
      moneyMoving: req.moneyMoving,
      provider: "paymob",
      operation: `paymob.${req.operation}`,
    });
    if (res.status === 401) {
      tokens.clear();
      if (attempt === 1 && !req.moneyMoving) continue;
    }
    ensureOk(res, "paymob", req.operation, message);
    return res.data;
  }
}

export function toId(id: string | number): number {
  const n = Number(id);
  if (!Number.isSafeInteger(n)) {
    throw new SarrafError("INVALID_REQUEST", `paymob id must be numeric (got "${id}")`, {
      provider: "paymob",
    });
  }
  return n;
}
