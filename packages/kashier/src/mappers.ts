import {
  asRecord,
  type Currency,
  isCurrency,
  type Money,
  type Payment,
  type PaymentMethod,
  type PaymentStatus,
  type StatusMappingRow,
  sarrafId,
  str,
  toMajorString,
  toMajorTrimmed,
  toMinor,
} from "@sarrafjs/core";
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
  {
    provider: "event pay, status SUCCESS",
    status: "succeeded",
    note: "fixtures/kashier/sandbox-webhook-succeeded-1.json",
    verified: true,
  },
  { provider: "status PENDING / INITIATED", status: "pending", verified: false },
  { provider: "status FAILURE / FAILED / DECLINED", status: "failed", verified: false },
  {
    provider: "event authorize, status SUCCESS",
    status: "requires_action",
    note: "authorized, needs capture",
    verified: false,
  },
  { provider: "event capture, status SUCCESS", status: "succeeded", verified: false },
  {
    provider: "event refund, status SUCCESS, partial (totals from the order lookup)",
    status: "partially_refunded",
    note: "fixtures/kashier/sandbox-webhook-refund-partial.json",
    verified: true,
  },
  {
    provider: "event refund, status SUCCESS, full (totals from the order lookup)",
    status: "refunded",
    note: "fixtures/kashier/sandbox-webhook-refund-full.json",
    verified: true,
  },
  {
    provider: "event void, status SUCCESS",
    status: "canceled",
    note: "fixtures/kashier/sandbox-webhook-void.json",
    verified: true,
  },
  {
    provider: "order lookup: status CAPTURED, nothing refunded",
    status: "succeeded",
    verified: false,
  },
  {
    provider: "order lookup: status CAPTURED, totalRefundedAmount < amount",
    status: "partially_refunded",
    note: "fixtures/kashier/sandbox-order-partially-refunded.json",
    verified: true,
  },
  {
    provider: "order lookup: status CAPTURED, totalRefundedAmount = amount",
    status: "refunded",
    note: "fixtures/kashier/sandbox-order-refunded.json",
    verified: true,
  },
  { provider: "status EXPIRED", status: "expired", verified: false },
  {
    provider: "order lookup: status CANCELLED (after a void)",
    status: "canceled",
    note: "fixtures/kashier/sandbox-void-succeeded.json",
    verified: true,
  },
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

/**
 * Status of an order from the order lookup. Kashier keeps a refunded order `CAPTURED` and tracks
 * refunds in `totalRefundedAmount`, so refunds are derived from the totals.
 */
export function mapKashierOrderStatus(
  status: string | undefined,
  amount: Money,
  refunded: Money,
): PaymentStatus {
  const s = (status ?? "").toUpperCase();
  switch (s) {
    case "CAPTURED":
    case "PAID":
    case "SUCCESS":
      if (amount.value > 0 && refunded.value >= amount.value) return "refunded";
      return refunded.value > 0 ? "partially_refunded" : "succeeded";
    case "REFUNDED":
      return "refunded";
    case "PARTIALLY_REFUNDED":
      return "partially_refunded";
    case "AUTHORIZED":
      return "requires_action";
    case "FAILED":
    case "REJECTED":
      return "failed";
    case "CANCELLED":
    case "CANCELED":
    case "VOIDED":
    case "REVERSED":
      return "canceled";
    case "EXPIRED":
      return "expired";
    default:
      return "pending";
  }
}

/** A `Payment` from an order returned by the order lookup (`findOrder`). */
export function toKashierOrderPayment(order: Record<string, unknown>, fallbackCurrency: Currency): Payment {
  const details = asRecord(order.order);
  const currency = isCurrency(details.currency) ? details.currency : fallbackCurrency;
  const amount: Money = {
    value: minorOf(details.amount ?? order.totalCapturedAmount ?? order.originalAmount, currency) ?? 0,
    currency,
  };
  const refunded: Money = { value: minorOf(order.totalRefundedAmount, currency) ?? 0, currency };
  const status = mapKashierOrderStatus(str(order.status), amount, refunded);
  const providerPaymentId = str(order.orderId) ?? "";
  const transactions = Array.isArray(order.transactions) ? order.transactions.map(asRecord) : [];
  const last = transactions.at(-1);
  const payment: Payment = {
    id: sarrafId("kashier", providerPaymentId),
    provider: "kashier",
    providerPaymentId,
    reference: str(order.merchantOrderId) ?? "",
    status,
    amount,
    amountRefunded: refunded,
    method: mapKashierMethod(str(order.method)),
    createdAt: str(order.date),
    updatedAt: str(order.lastModifiedDate),
    raw: order,
  };
  if (status === "failed") {
    const message = asRecord(last?.transactionResponseMessage);
    payment.failure = {
      code: "PAYMENT_DECLINED",
      message: str(message.en) ?? "Payment failed",
      providerCode: str(last?.transactionResponseCode),
    };
  }
  return payment;
}
