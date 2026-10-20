import {
  type Currency,
  type Money,
  type Payment,
  type PaymentMethod,
  type PaymentStatus,
  type StatusMappingRow,
  asRecord,
  isCurrency,
  refundedStatus,
  sarrafId,
  str,
} from "@sarraf/core";

/** Paymob transaction object (callback `obj` and transaction inquiry response share this shape). */
export interface PaymobTransaction {
  id: number;
  pending: boolean;
  success: boolean;
  amount_cents: number;
  currency: string;
  created_at?: string | undefined;
  error_occured?: boolean | undefined;
  is_refunded?: boolean | undefined;
  is_refund?: boolean | undefined;
  is_voided?: boolean | undefined;
  is_void?: boolean | undefined;
  refunded_amount_cents?: number | undefined;
  order?: { id: number; merchant_order_id?: string | null } | number | undefined;
  source_data?: { pan?: string; sub_type?: string; type?: string } | undefined;
  data?: { message?: string; txn_response_code?: string | number; [k: string]: unknown } | undefined;
  special_reference?: string | undefined;
  [key: string]: unknown;
}

/** Status mapping table, exported for docs and the dashboard status explorer. */
export const PAYMOB_STATUS_TABLE: StatusMappingRow[] = [
  { provider: "is_voided: true", status: "canceled", verified: true },
  { provider: "pending: true", status: "pending", verified: true },
  { provider: "success: true, is_refunded: false, is_voided: false", status: "succeeded", verified: true },
  {
    provider: "success: true, is_refunded: true, refunded_amount_cents < amount_cents",
    status: "partially_refunded",
    note: "refunded_amount_cents field name to confirm with a fixture",
    verified: false,
  },
  { provider: "success: true, is_refunded: true, fully refunded", status: "refunded", verified: true },
  {
    provider: "is_refund: true (refund transaction callback)",
    status: "refunded",
    note: "emitted as refund.succeeded / refund.failed",
    verified: false,
  },
  {
    provider: "success: false, pending: false",
    status: "failed",
    note: "data.message → failure.message",
    verified: true,
  },
];

const truthy = (v: unknown) => v === true || v === "true";

export function mapPaymobStatus(
  txn: Pick<PaymobTransaction, "pending" | "success"> & Partial<PaymobTransaction>,
  amount: Money,
): PaymentStatus {
  if (truthy(txn.is_voided) || truthy(txn.is_void)) return "canceled";
  if (truthy(txn.is_refund)) return "refunded";
  if (truthy(txn.pending)) return "pending";
  if (truthy(txn.success)) {
    if (truthy(txn.is_refunded)) {
      const refunded = Number(txn.refunded_amount_cents);
      return Number.isFinite(refunded) && refunded > 0
        ? refundedStatus(amount, { value: refunded, currency: amount.currency })
        : "refunded";
    }
    return "succeeded";
  }
  return "failed";
}

export function mapPaymobMethod(sourceType: string | undefined): PaymentMethod | undefined {
  if (!sourceType) return undefined;
  const t = sourceType.toLowerCase();
  if (t === "card") return "card";
  if (t === "wallet") return "wallet";
  if (t === "aggregator" || t === "cash_present" || t === "kiosk") return "cash_outlet";
  if (t.includes("valu") || t.includes("installment") || t.includes("bnpl")) return "installments";
  return "other";
}

export function orderId(txn: PaymobTransaction): string | undefined {
  return typeof txn.order === "object" && txn.order ? str(txn.order.id) : str(txn.order);
}

export function merchantReference(txn: PaymobTransaction): string {
  const order = typeof txn.order === "object" && txn.order ? txn.order : undefined;
  return (
    str(order?.merchant_order_id) ?? str(txn.special_reference) ?? str(asRecord(txn.extras).sarraf_ref) ?? ""
  );
}

export function toPaymobPayment(txn: PaymobTransaction, fallbackCurrency: Currency): Payment {
  const currency = isCurrency(txn.currency) ? txn.currency : fallbackCurrency;
  const amount: Money = { value: Number(txn.amount_cents), currency };
  const status = mapPaymobStatus(txn, amount);
  let refundedCents = 0;
  if (status === "partially_refunded") refundedCents = Number(txn.refunded_amount_cents);
  else if (status === "refunded") {
    // A refund transaction's own amount is the refunded amount.
    refundedCents = truthy(txn.is_refund) ? amount.value : Number(txn.refunded_amount_cents) || amount.value;
  }
  const source = txn.source_data ?? {};
  const pan = str(source.pan);
  const payment: Payment = {
    id: sarrafId("paymob", txn.id),
    provider: "paymob",
    providerPaymentId: String(txn.id),
    reference: merchantReference(txn),
    status,
    amount,
    amountRefunded: { value: refundedCents, currency },
    method: mapPaymobMethod(source.type),
    createdAt: txn.created_at,
    raw: txn,
  };
  if (source.type === "card" && (pan || source.sub_type)) {
    payment.card = { last4: pan ? pan.slice(-4) : undefined, brand: source.sub_type };
  }
  if (status === "failed") {
    payment.failure = {
      code: "PAYMENT_DECLINED",
      message: str(txn.data?.message) ?? "Payment failed",
      providerCode: str(txn.data?.txn_response_code),
    };
  }
  return payment;
}
