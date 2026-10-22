import { type Money, type PaymentStatus, type ProviderId, toMajorString } from "@sarrafjs/core";

export const PRODUCT = {
  name: "Field Notes, pack of 3",
  description: "Pocket notebooks with 48 dot-grid pages each.",
  price: { value: 250_00, currency: "EGP" } satisfies Money,
};

export const MAX_QUANTITY = 5;

export const PROVIDER_INFO: Record<ProviderId, { label: string; detail: string }> = {
  paymob: { label: "Paymob", detail: "Card or mobile wallet" },
  kashier: { label: "Kashier", detail: "Card or mobile wallet" },
  fawry: { label: "Fawry", detail: "Pay cash at any Fawry outlet" },
};

export const formatMoney = (m: Money): string => `${m.currency} ${toMajorString(m.value, m.currency)}`;

const PENDING: PaymentStatus[] = ["pending", "requires_action", "awaiting_payment"];
export const isPending = (status: PaymentStatus): boolean => PENDING.includes(status);

const HEADLINES: Record<PaymentStatus, string> = {
  pending: "Waiting for payment",
  requires_action: "Waiting for payment",
  awaiting_payment: "Waiting for payment",
  succeeded: "Payment received",
  failed: "Payment failed",
  canceled: "Order canceled",
  expired: "Payment expired",
  refunded: "Refunded",
  partially_refunded: "Partially refunded",
};
export const headline = (status: PaymentStatus): string => HEADLINES[status];

export function statusTone(status: PaymentStatus): "ok" | "bad" | "wait" | "" {
  if (status === "succeeded") return "ok";
  if (status === "failed" || status === "expired" || status === "canceled") return "bad";
  return isPending(status) ? "wait" : "";
}
