import {
  asRecord,
  type Ctx,
  ensureOk,
  type HttpResponse,
  SarrafError,
  type SarrafErrorCode,
  str,
} from "@sarrafjs/core";
import type { FawryConfig } from "./config.js";
import {
  type FawryExpressItem,
  type FawryNotificationV2,
  fawryCancelSignature,
  fawryChargeSignature,
  fawryExpressCheckoutSignature,
  fawryRefundSignature,
  fawryStatusSignature,
} from "./signature.js";

/** Thin wrappers around Fawry endpoints. Fawry reports errors in `statusCode` even on HTTP 200. */

export interface FawryChargeItem {
  itemId: string;
  description: string;
  price: number;
  quantity: number;
}

export interface FawryChargeRequest {
  merchantRefNum: string;
  customerProfileId?: string | undefined;
  customerName?: string | undefined;
  customerMobile: string;
  customerEmail?: string | undefined;
  paymentMethod: "PAYATFAWRY";
  amount: string;
  currencyCode: "EGP";
  description: string;
  paymentExpiry?: number | undefined;
  chargeItems: FawryChargeItem[];
  language: string;
}

export interface FawryChargeResponse {
  type?: string | undefined;
  referenceNumber?: string | number | undefined;
  merchantRefNumber?: string | undefined;
  expirationTime?: number | undefined;
  statusCode?: number | undefined;
  statusDescription?: string | undefined;
  orderStatus?: string | undefined;
  [k: string]: unknown;
}

const DUPLICATE_CODES = new Set(["9946"]);
const AUTH_CODES = new Set(["9901", "9919"]);

/** Throw for HTTP errors and for non-200 `statusCode` bodies. */
export function ensureFawryOk<T>(res: HttpResponse<T>, operation: string): T {
  ensureOk(
    res,
    "fawry",
    operation,
    (d) => str(asRecord(d).statusDescription) ?? str(asRecord(d).description),
  );
  const body = asRecord(res.data);
  const code = body.statusCode;
  if (code !== undefined && Number(code) !== 200) {
    const providerCode = str(code) ?? "unknown";
    const description = str(body.statusDescription) ?? "unknown error";
    let errorCode: SarrafErrorCode = "INVALID_REQUEST";
    if (DUPLICATE_CODES.has(providerCode) || /duplicate/i.test(description))
      errorCode = "DUPLICATE_REFERENCE";
    else if (AUTH_CODES.has(providerCode) || /signature|merchant/i.test(description))
      errorCode = "AUTHENTICATION_FAILED";
    else if (/not found|no order/i.test(description)) errorCode = "NOT_FOUND";
    throw new SarrafError(errorCode, `fawry ${operation} failed: ${providerCode} ${description}`, {
      provider: "fawry",
      providerCode,
      raw: body,
    });
  }
  return res.data;
}

export async function charge(
  cfg: FawryConfig,
  ctx: Ctx,
  req: FawryChargeRequest,
): Promise<FawryChargeResponse> {
  const { signature } = fawryChargeSignature(
    {
      merchantCode: cfg.merchantCode,
      merchantRefNum: req.merchantRefNum,
      customerProfileId: req.customerProfileId,
      paymentMethod: req.paymentMethod,
      amount: req.amount,
    },
    cfg.secureKey,
  );
  const res = await ctx.http.request<FawryChargeResponse>({
    method: "POST",
    url: `${cfg.baseUrl}/ECommerceWeb/Fawry/payments/charge`,
    body: {
      merchantCode: cfg.merchantCode,
      ...req,
      amount: Number(req.amount),
      chargeItems: req.chargeItems,
      signature,
    },
    moneyMoving: true,
    provider: "fawry",
    operation: "fawry.charge",
  });
  return ensureFawryOk(res, "charge");
}

export async function getStatus(
  cfg: FawryConfig,
  ctx: Ctx,
  merchantRefNumber: string,
): Promise<
  FawryNotificationV2 & { referenceNumber?: string | undefined; statusDescription?: string | undefined }
> {
  const { signature } = fawryStatusSignature(cfg.merchantCode, merchantRefNumber, cfg.secureKey);
  const res = await ctx.http.request<FawryNotificationV2 & { referenceNumber?: string | undefined }>({
    method: "GET",
    url: `${cfg.baseUrl}/ECommerceWeb/Fawry/payments/status/v2`,
    query: { merchantCode: cfg.merchantCode, merchantRefNumber, signature },
    provider: "fawry",
    operation: "fawry.status",
  });
  return ensureFawryOk(res, "status");
}

export async function refund(
  cfg: FawryConfig,
  ctx: Ctx,
  input: { referenceNumber: string; refundAmount: string; reason?: string | undefined },
): Promise<Record<string, unknown>> {
  const { signature } = fawryRefundSignature({ merchantCode: cfg.merchantCode, ...input }, cfg.secureKey);
  const res = await ctx.http.request<Record<string, unknown>>({
    method: "POST",
    url: `${cfg.baseUrl}/ECommerceWeb/Fawry/payments/refund`,
    body: {
      merchantCode: cfg.merchantCode,
      referenceNumber: input.referenceNumber,
      refundAmount: Number(input.refundAmount),
      reason: input.reason,
      signature,
    },
    moneyMoving: true,
    provider: "fawry",
    operation: "fawry.refund",
  });
  return ensureFawryOk(res, "refund");
}

/** Cancel an unpaid reference code. ⚠️ path and signature to confirm. */
export async function cancelUnpaid(
  cfg: FawryConfig,
  ctx: Ctx,
  orderRefNo: string,
): Promise<Record<string, unknown>> {
  const lang = cfg.language;
  const { signature } = fawryCancelSignature(
    { merchantAccount: cfg.merchantCode, orderRefNo, lang },
    cfg.secureKey,
  );
  const res = await ctx.http.request<Record<string, unknown>>({
    method: "POST",
    url: `${cfg.baseUrl}/ECommerceWeb/api/orders/cancel-unpaid-order`,
    body: { merchantAccount: cfg.merchantCode, orderRefNo, lang, signature },
    moneyMoving: true,
    provider: "fawry",
    operation: "fawry.cancel",
  });
  return ensureFawryOk(res, "cancel");
}

export interface FawryExpressInitRequest {
  merchantRefNum: string;
  customerProfileId?: string | undefined;
  customerName?: string | undefined;
  customerMobile: string;
  customerEmail?: string | undefined;
  paymentExpiry?: number | undefined;
  language: string;
  returnUrl: string;
  chargeItems: (FawryChargeItem & FawryExpressItem)[];
  paymentMethod?: string | undefined;
  authCaptureModePayment: false;
}

/** Hosted checkout (FawryPay payment link). Returns the checkout URL. ⚠️ Beta. */
export async function expressInit(cfg: FawryConfig, ctx: Ctx, req: FawryExpressInitRequest): Promise<string> {
  const { signature } = fawryExpressCheckoutSignature(
    {
      merchantCode: cfg.merchantCode,
      merchantRefNum: req.merchantRefNum,
      customerProfileId: req.customerProfileId,
      returnUrl: req.returnUrl,
      items: req.chargeItems,
    },
    cfg.secureKey,
  );
  const res = await ctx.http.request<unknown>({
    method: "POST",
    url: `${cfg.baseUrl}/fawrypay-api/api/payments/init`,
    body: { merchantCode: cfg.merchantCode, ...req, signature },
    moneyMoving: true,
    provider: "fawry",
    operation: "fawry.expressInit",
  });
  const data = ensureFawryOk(res, "expressInit");
  const url =
    typeof data === "string" ? data.trim() : (str(asRecord(data).url) ?? str(asRecord(data).paymentUrl));
  if (!url || !/^https:\/\//.test(url)) {
    throw new SarrafError("PROVIDER_UNAVAILABLE", "fawry expressInit returned no checkout URL", {
      provider: "fawry",
      raw: data,
    });
  }
  return url;
}
