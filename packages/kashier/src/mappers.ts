import {
  type Currency,
  type Money,
  type Payment,
  type PaymentMethod,
  type PaymentStatus,
  type StatusMappingRow,
  asRecord,
  isCurrency,
  sarrafId,
  str,
  toMajorString,
  toMajorTrimmed,
  toMinor,
} from "@sarraf/core";
import type { KashierConfig } from "./config.js";

/** Kashier webhook `data` (also the shape of order lookups). ⚠️ field names to confirm with fixtures. */
export interface KashierTransactionData {
  merchantOrderId?: string | undefined;
  kashierOrderId?: string | undefined;
  orderReference?: string | undefined;
  transactionId?: string | undefined;
  status?: string | undefined;
  method?: string | undefined;
  creationDate?: string | undefined;
  amount?: number | string | undefined;
  currency?: string | undefined;
  card?: { cardInfo?: { cardBrand?: string; maskedCard?: string } } | undefined;
  cardBrand?: string | undefined;
  maskedCard?: string | undefined;
  transactionResponseCode?: string | undefined;
  transactionResponseMessage?: { en?: string; ar?: string } | string | undefined;
  refundedAmount?: number | string | undefined;
  totalRefundedAmount?: number | string | undefined;
  signatureKeys?: string[] | undefined;
  [k: string]: unknown;
}

export const KASHIER_STATUS_TABLE: StatusMappingRow[] = [
  { provider: "event pay, status SUCCESS", status: "succeeded", verified: false },
  { provider: "status PENDING / INITIATED", status: "pending", verified: false },
  { provider: "status FAILURE / FAILED / DECLINED", status: "failed", verified: false },
  {
    provider: "event authorize, status SUCCESS",
    status: "requires_action",
    note: "authorized, needs capture",
    verified: false,
  },
  { provider: "event capture, status SUCCESS", status: "succeeded", verified: false },
  { provider: "event refund, status SUCCESS, partial", status: "partially_refunded", verified: false },
  { provider: "event refund, status SUCCESS, full", status: "refunded", verified: false },
  { provider: "event void, status SUCCESS", status: "canceled", verified: false },
  { provider: "status EXPIRED", status: "expired", verified: false },
  { provider: "status CANCELLED / CANCELED", status: "canceled", verified: false },
];

/** Known Kashier event names; `(string & {})` keeps autocomplete while accepting new ones. */
export type KashierEvent = "pay" | "refund" | "authorize" | "capture" | "void" | (string & {});

export function mapKashierStatus(
  event: KashierEvent | undefined,
  status: string | undefined,
  refund?: { amount: Money; refunded?: Money | undefined },
): PaymentStatus {
  const s = (status ?? "").toUpperCase();
  const e = (event ?? "pay").toLowerCase();
  if (s === "PENDING" || s === "INITIATED" || s === "") return "pending";
  if (s === "FAILURE" || s === "FAILED" || s === "DECLINED" || s === "ERROR") return "failed";
  if (s === "EXPIRED") return "expired";
  if (s === "CANCELLED" || s === "CANCELED") return "canceled";
  if (s === "SUCCESS" || s === "CAPTURED" || s === "APPROVED") {
    if (e === "refund") {
      if (refund?.refunded && refund.refunded.value < refund.amount.value) return "partially_refunded";
      return "refunded";
    }
    if (e === "void") return "canceled";
    if (e === "authorize") return "requires_action";
    return "succeeded";
  }
  return "pending";
}

export function mapKashierMethod(method: string | undefined): PaymentMethod | undefined {
  if (!method) return undefined;
  const m = method.toLowerCase();
  if (m.includes("card")) return "card";
  if (m.includes("wallet")) return "wallet";
  if (m.includes("installment")) return "installments";
  if (m.includes("valu") || m.includes("bnpl") || m.includes("souhoola") || m.includes("aman")) return "bnpl";
  if (m.includes("bank")) return "bank_transfer";
  return "other";
}

/** Kashier `allowedMethods` names. ⚠️ confirm the full list per account. */
export const KASHIER_METHOD_NAMES: Partial<Record<PaymentMethod, string>> = {
  card: "card",
  wallet: "wallet",
  installments: "bank_installments",
  bnpl: "valu",
};

/** Major-unit amount string for the hash and URL. Identical string in both is what matters. */
export function formatKashierAmount(
  minor: number,
  currency: Currency,
  cfg: Pick<KashierConfig, "amountFormat">,
): string {
  return cfg.amountFormat === "trimmed" ? toMajorTrimmed(minor, currency) : toMajorString(minor, currency);
}

function minorOf(value: unknown, currency: Currency): number | undefined {
  if (typeof value === "number") return toMinor(value, currency);
  const s = str(value);
  return s ? toMinor(s, currency) : undefined;
}

export function toKashierPayment(
  data: KashierTransactionData,
  event: KashierEvent | undefined,
  fallbackCurrency: Currency,
): Payment {
  const currency = isCurrency(data.currency) ? data.currency : fallbackCurrency;
  const amount: Money = { value: minorOf(data.amount, currency) ?? 0, currency };
  const refundedMinor = minorOf(data.totalRefundedAmount ?? data.refundedAmount, currency);
  const isRefund = (event ?? "").toLowerCase() === "refund";
  // For refund events `amount` may be the refunded amount; total refunded wins when present. ⚠️
  const orderAmount = minorOf(data.orderAmount ?? data.totalAmount, currency);
  const baseAmount: Money = isRefund && orderAmount !== undefined ? { value: orderAmount, currency } : amount;
  const refunded: Money | undefined = isRefund
    ? { value: refundedMinor ?? amount.value, currency }
    : refundedMinor !== undefined
      ? { value: refundedMinor, currency }
      : undefined;
  const status = mapKashierStatus(event, data.status, { amount: baseAmount, refunded });
  const providerPaymentId =
    str(data.kashierOrderId) ?? str(data.transactionId) ?? str(data.merchantOrderId) ?? "";
  const cardInfo = asRecord(asRecord(data.card).cardInfo);
  const masked = str(data.maskedCard) ?? str(cardInfo.maskedCard);
  const brand = str(data.cardBrand) ?? str(cardInfo.cardBrand);
  const message =
    typeof data.transactionResponseMessage === "string"
      ? data.transactionResponseMessage
      : data.transactionResponseMessage?.en;
  const payment: Payment = {
    id: sarrafId("kashier", providerPaymentId),
    provider: "kashier",
    providerPaymentId,
    reference: str(data.merchantOrderId) ?? "",
    status,
    amount: baseAmount,
    amountRefunded: { value: refunded?.value ?? 0, currency },
    method: mapKashierMethod(data.method),
    createdAt: data.creationDate,
    raw: data,
  };
  if (masked || brand) payment.card = { last4: masked?.replace(/\D/g, "").slice(-4) || undefined, brand };
  if (status === "failed") {
    payment.failure = {
      code: "PAYMENT_DECLINED",
      message: message ?? "Payment failed",
      providerCode: str(data.transactionResponseCode),
    };
  }
  return payment;
}
