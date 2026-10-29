import {
  asRecord,
  type Currency,
  isCurrency,
  type Money,
  type Payment,
  type PaymentMethod,
  type PaymentStatus,
  refundedStatus,
  type SavedCard,
  type StatusMappingRow,
  sarrafId,
  str,
} from "@sarrafjs/core";

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
  is_auth?: boolean | undefined;
  is_capture?: boolean | undefined;
  captured_amount?: number | undefined;
  refunded_amount_cents?: number | undefined;
  /** Original transaction id on refund / void / capture transactions. */
  parent_transaction?: number | null | undefined;
  integration_id?: number | undefined;
  order?: { id: number; merchant_order_id?: string | null } | number | undefined;
  source_data?: { pan?: string; sub_type?: string; type?: string } | undefined;
  data?:
    | {
        message?: string;
        txn_response_code?: string | number;
        /** Kiosk (Aman / Masary) payment reference. */
        bill_reference?: string | number;
        [k: string]: unknown;
      }
    | undefined;
  special_reference?: string | undefined;
  [key: string]: unknown;
}

/** Status mapping table, exported for docs and the dashboard status explorer. */
export const PAYMOB_STATUS_TABLE: StatusMappingRow[] = [
  { provider: "is_voided: true", status: "canceled", verified: true },
  {
    provider: "pending: true, source_data.type: aggregator (kiosk)",
    status: "awaiting_payment",
    note: "customer pays the bill reference at a kiosk",
    verified: false,
  },
  { provider: "pending: true", status: "pending", verified: true },
  {
    provider: "success: true, is_auth: true, is_capture: false, nothing captured",
    status: "requires_action",
    note: "authorized, needs capture",
    verified: false,
  },
  {
    provider: "success: true, is_capture: true (capture transaction)",
    status: "succeeded",
    verified: false,
  },
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
    note: "emitted as refund.succeeded / refund.failed with the parent payment's totals",
    verified: false,
  },
  {
    provider: "success: false, pending: false",
    status: "failed",
    note: "data.message → failure.message",
    verified: true,
  },
];

/** Paymob sends booleans as JSON booleans in callbacks and as strings in redirects. */
export const truthy = (v: unknown): boolean => v === true || v === "true";

export function mapPaymobStatus(
  txn: Pick<PaymobTransaction, "pending" | "success"> & Partial<PaymobTransaction>,
  amount: Money,
): PaymentStatus {
  if (truthy(txn.is_voided) || truthy(txn.is_void)) return "canceled";
  if (truthy(txn.is_refund)) return "refunded";
  if (truthy(txn.pending)) return isKiosk(txn) ? "awaiting_payment" : "pending";
  if (truthy(txn.success)) {
    if (truthy(txn.is_auth) && !truthy(txn.is_capture) && !(Number(txn.captured_amount) > 0)) {
      return "requires_action";
    }
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

/** BNPL lenders Paymob offers (Egypt, KSA, UAE). Matched against `source_data.type` / `sub_type`. */
const BNPL =
  /valu|souhoola|sympl|premium|halan|klivvr|forsa|contact|seven|\btru\b|mogo|mylo|tabby|tamara|bnpl|aman/;

export function mapPaymobMethod(sourceType: string | undefined): PaymentMethod | undefined {
  if (!sourceType) return undefined;
  const t = sourceType.toLowerCase();
  if (t === "card" || t === "apple_pay" || t === "google_pay") return "card";
  if (t === "wallet") return "wallet";
  if (t === "aggregator" || t === "cash_present" || t === "kiosk") return "cash_outlet";
  if (t.includes("bank_installment")) return "installments";
  if (BNPL.test(t)) return "bnpl";
  if (t.includes("installment")) return "installments";
  return "other";
}

function isKiosk(txn: Partial<PaymobTransaction>): boolean {
  return mapPaymobMethod(txn.source_data?.type) === "cash_outlet";
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

/** A card-token object (callback `obj`, order card-token inquiry, subscription cards). */
export function toSavedCard(obj: Record<string, unknown>): SavedCard {
  const masked = str(obj.masked_pan);
  return {
    token: str(obj.token) ?? "",
    last4: masked ? masked.replace(/\D/g, "").slice(-4) || undefined : undefined,
    brand: str(obj.card_subtype),
    expiryMonth: str(obj.expiry_month),
    expiryYear: str(obj.expiry_year),
    holderName: str(obj.cardholder_name),
    email: str(obj.email),
  };
}
