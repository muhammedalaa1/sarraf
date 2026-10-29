import {
  type Currency,
  type Payment,
  type PaymentMethod,
  type PaymentStatus,
  refundedStatus,
  SarrafError,
  type StatusMappingRow,
  sarrafId,
  str,
  toMinor,
} from "@sarrafjs/core";
import type { FawryNotificationV2 } from "./signature.js";

export const FAWRY_STATUS_TABLE: StatusMappingRow[] = [
  { provider: "NEW / UNPAID (PAYATFAWRY)", status: "awaiting_payment", verified: false },
  { provider: "NEW / UNPAID (card, wallet)", status: "pending", verified: false },
  { provider: "PAID", status: "succeeded", verified: false },
  { provider: "EXPIRED", status: "expired", verified: false },
  { provider: "CANCELED / CANCELLED", status: "canceled", verified: false },
  { provider: "REFUNDED", status: "refunded", verified: false },
  { provider: "PARTIAL_REFUNDED", status: "partially_refunded", verified: false },
  { provider: "FAILED", status: "failed", verified: false },
];

export const FAWRY_METHODS: Record<string, PaymentMethod> = {
  PAYATFAWRY: "cash_outlet",
  CARD: "card",
  MWALLET: "wallet",
  VALU: "installments",
  CASHONDELIVERY: "other",
};

export function mapFawryMethod(method: string | undefined): PaymentMethod | undefined {
  if (!method) return undefined;
  return FAWRY_METHODS[method.toUpperCase()] ?? "other";
}

export function mapFawryStatus(orderStatus: string | undefined, paymentMethod?: string): PaymentStatus {
  const s = (orderStatus ?? "").toUpperCase();
  switch (s) {
    case "PAID":
      return "succeeded";
    case "EXPIRED":
      return "expired";
    case "CANCELED":
    case "CANCELLED":
      return "canceled";
    case "REFUNDED":
      return "refunded";
    case "PARTIAL_REFUNDED":
    case "PARTIALLY_REFUNDED":
      return "partially_refunded";
    case "FAILED":
    case "DECLINED":
      return "failed";
    default:
      return (paymentMethod ?? "").toUpperCase() === "PAYATFAWRY" ? "awaiting_payment" : "pending";
  }
}

/** Local Egyptian mobile format Fawry expects: "+201001234567" → "01001234567". */
export function toFawryMobile(phone: string): string {
  const digits = phone.replace(/[^\d]/g, "");
  if (digits.startsWith("20") && digits.length === 12) return `0${digits.slice(2)}`;
  if (digits.startsWith("0020")) return `0${digits.slice(4)}`;
  return digits;
}

function dateString(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  const d = Number.isFinite(n) ? new Date(n) : new Date(str(v) ?? "");
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Normalize a V2 notification or a status v2 response (same field names). */
export function toFawryPayment(
  n: FawryNotificationV2 & {
    referenceNumber?: string | number | undefined;
    refundedAmount?: number | string | undefined;
  },
): Payment {
  const providerPaymentId = str(n.fawryRefNumber) ?? str(n.referenceNumber) ?? "";
  const currency: Currency = "EGP";
  const amountMajor = n.orderAmount ?? n.paymentAmount;
  if (amountMajor === undefined) {
    throw new SarrafError("INVALID_REQUEST", "fawry: payload has no orderAmount / paymentAmount", {
      provider: "fawry",
    });
  }
  const amount = { value: toMinor(String(amountMajor), currency), currency };
  let status = mapFawryStatus(n.orderStatus, n.paymentMethod);
  let refunded = 0;
  if (n.refundedAmount !== undefined && n.refundedAmount !== null) {
    refunded = toMinor(String(n.refundedAmount), currency);
    if (status === "refunded" && refunded > 0) status = refundedStatus(amount, { value: refunded, currency });
  } else if (status === "refunded") refunded = amount.value;
  const payment: Payment = {
    id: sarrafId("fawry", providerPaymentId),
    provider: "fawry",
    providerPaymentId,
    reference: str(n.merchantRefNumber) ?? str(n.merchantRefNum) ?? "",
    status,
    amount,
    amountRefunded: { value: refunded, currency },
    method: mapFawryMethod(n.paymentMethod),
    updatedAt: dateString(n.paymentTime),
    raw: n,
  };
  if (status === "failed") {
    payment.failure = { code: "PAYMENT_DECLINED", message: str(n.statusDescription) ?? "Payment failed" };
  }
  return payment;
}
