import { SarrafError } from "./errors.js";
import type {
  Money,
  Payment,
  PaymentLookup,
  PaymentStatus,
  ProviderId,
  SarrafEvent,
  SarrafEventType,
} from "./types.js";

export function sarrafId(provider: ProviderId, providerId: string | number): string {
  return `${provider}_${providerId}`;
}

/** The event type emitted for a payment that reached `status`. */
export function eventTypeForStatus(status: PaymentStatus): SarrafEventType {
  switch (status) {
    case "succeeded":
      return "payment.succeeded";
    case "failed":
      return "payment.failed";
    case "expired":
      return "payment.expired";
    case "canceled":
      return "payment.canceled";
    case "refunded":
    case "partially_refunded":
      return "refund.succeeded";
    default:
      return "payment.pending";
  }
}

export function buildEvent(args: {
  provider: ProviderId;
  providerEventId: string | number;
  payment: Payment;
  type?: SarrafEventType | undefined;
  receivedAt: Date;
  raw: unknown;
}): SarrafEvent {
  const type = args.type ?? eventTypeForStatus(args.payment.status);
  return {
    id: `${args.provider}:${args.providerEventId}:${args.payment.status}`,
    type,
    provider: args.provider,
    payment: args.payment,
    receivedAt: args.receivedAt.toISOString(),
    raw: args.raw,
  };
}

/** Refund status from refunded vs. captured amount. */
export function refundedStatus(amount: Money, refunded: Money): PaymentStatus {
  return refunded.value >= amount.value ? "refunded" : "partially_refunded";
}

/**
 * The id to look a payment up by: `providerPaymentId` when given, else `reference`.
 * Throws `INVALID_REQUEST` when neither is set, so adapters never need a non-null assertion.
 */
export function requireLookupKey(lookup: PaymentLookup, provider: ProviderId): string {
  const key = lookup.providerPaymentId ?? lookup.reference;
  if (!key) {
    throw new SarrafError("INVALID_REQUEST", "Pass providerPaymentId or reference.", { provider });
  }
  return key;
}
