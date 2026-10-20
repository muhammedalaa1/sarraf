import type { SarrafErrorCode } from "./errors.js";
import type { HttpClient } from "./http.js";
import type { IdempotencyStore } from "./idempotency/store.js";
import type { Logger } from "./logger.js";

/**
 * Registry of provider ids. Third-party adapters extend it with module augmentation:
 *
 * ```ts
 * declare module "@sarraf/core" { interface ProviderRegistry { tap: true } }
 * ```
 */
export interface ProviderRegistry {
  paymob: true;
  kashier: true;
  fawry: true;
}
export type ProviderId = Extract<keyof ProviderRegistry, string>;

export type Currency = "EGP" | "SAR" | "AED" | "OMR" | "KWD" | "BHD" | "JOD" | "QAR" | "USD" | "EUR";

/** Integer minor units, never floats. 250.00 EGP is `{ value: 25000, currency: "EGP" }`. */
export interface Money {
  value: number;
  currency: Currency;
}

export type PaymentMethod =
  | "card"
  | "wallet"
  | "cash_outlet"
  | "installments"
  | "bnpl"
  | "bank_transfer"
  | "other";

export interface Customer {
  name?: string | undefined;
  email?: string | undefined;
  phone: string;
}

export interface LineItem {
  name: string;
  unitAmount: Money;
  quantity: number;
  sku?: string | undefined;
}

/** Per-adapter typed options, extended by adapters via module augmentation. */
// biome-ignore lint/suspicious/noEmptyInterface: augmentation target
export interface ProviderOptionsRegistry {}

export interface CreateCheckoutInput<Id extends ProviderId = ProviderId> {
  provider: Id;
  amount: Money;
  /** Merchant order id. Some providers require it to be unique per attempt. */
  reference: string;
  customer: Customer;
  items?: LineItem[] | undefined;
  methods?: PaymentMethod[] | undefined;
  returnUrl?: string | undefined;
  webhookUrl?: string | undefined;
  expiresInSeconds?: number | undefined;
  locale?: "en" | "ar" | undefined;
  idempotencyKey?: string | undefined;
  metadata?: Record<string, string> | undefined;
  providerOptions?:
    | (Id extends keyof ProviderOptionsRegistry ? ProviderOptionsRegistry[Id] : Record<string, unknown>)
    | undefined;
}

export type CheckoutKind = "redirect" | "reference_code";

export interface Checkout {
  /** `"<provider>_<providerCheckoutId>"` */
  id: string;
  provider: ProviderId;
  kind: CheckoutKind;
  redirectUrl?: string | undefined;
  referenceCode?: string | undefined;
  expiresAt?: string | undefined;
  payment: Payment;
  raw: unknown;
}

export type PaymentStatus =
  | "pending"
  | "requires_action"
  | "awaiting_payment"
  | "succeeded"
  | "failed"
  | "canceled"
  | "expired"
  | "refunded"
  | "partially_refunded";

export const PAYMENT_STATUSES: readonly PaymentStatus[] = [
  "pending",
  "requires_action",
  "awaiting_payment",
  "succeeded",
  "failed",
  "canceled",
  "expired",
  "refunded",
  "partially_refunded",
];

export interface PaymentFailure {
  code: SarrafErrorCode;
  message: string;
  providerCode?: string | undefined;
}

export interface Payment {
  /** `"<provider>_<providerPaymentId>"` */
  id: string;
  provider: ProviderId;
  providerPaymentId: string;
  reference: string;
  status: PaymentStatus;
  amount: Money;
  amountRefunded: Money;
  method?: PaymentMethod | undefined;
  /** Display-only, as returned by the provider. Sarraf never handles card data. */
  card?: { last4?: string | undefined; brand?: string | undefined } | undefined;
  failure?: PaymentFailure | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  raw: unknown;
}

export interface PaymentLookup {
  /** Provider transaction / payment id. */
  providerPaymentId?: string | undefined;
  /** Merchant reference passed at checkout. */
  reference?: string | undefined;
}

export interface RefundInput {
  providerPaymentId: string;
  /** Merchant reference of the original payment, used by providers that refund by order. */
  reference?: string | undefined;
  /** Defaults to the full amount when the provider supports it. */
  amount?: Money | undefined;
  reason?: string | undefined;
  idempotencyKey?: string | undefined;
}

export type RefundStatus = "pending" | "succeeded" | "failed";

export interface Refund {
  id: string;
  provider: ProviderId;
  providerRefundId?: string | undefined;
  providerPaymentId: string;
  status: RefundStatus;
  amount?: Money | undefined;
  payment?: Payment | undefined;
  raw: unknown;
}

export type SarrafEventType =
  | "payment.succeeded"
  | "payment.failed"
  | "payment.pending"
  | "payment.expired"
  | "payment.canceled"
  | "refund.succeeded"
  | "refund.failed";

export interface SarrafEvent {
  /** Stable dedupe key: `"<provider>:<providerEventOrTxnId>:<status>"`. */
  id: string;
  type: SarrafEventType;
  provider: ProviderId;
  payment: Payment;
  receivedAt: string;
  raw: unknown;
}

export type HeaderValue = string | string[] | undefined;

export interface RawWebhookRequest {
  headers?: Record<string, HeaderValue> | Headers | undefined;
  /** The exact bytes the provider sent. Do not pass a re-serialized JSON body. */
  rawBody: string | Uint8Array;
  query?: Record<string, HeaderValue> | undefined;
}

export interface VerifiedWebhook {
  provider: ProviderId;
  body: unknown;
  headers: Record<string, string>;
  query: Record<string, string>;
}

/** Diagnostics for a webhook signature check, used by the dashboard and for debugging. */
export interface WebhookInspection {
  valid: boolean;
  /** The exact string that was hashed. Contains no secrets. */
  signedString?: string | undefined;
  expected?: string | undefined;
  received?: string | undefined;
  algorithm: string;
  reason?: string | undefined;
}

export interface RedirectResult {
  provider: ProviderId;
  /** True when the provider signs redirect params and the signature matched. */
  authenticated: boolean;
  status: PaymentStatus | "unknown";
  reference?: string | undefined;
  providerPaymentId?: string | undefined;
  raw: Record<string, string>;
}

export type CapabilityLevel = "supported" | "beta" | "unsupported";

export interface Capabilities {
  checkout: CapabilityLevel;
  getPayment: CapabilityLevel;
  refund: CapabilityLevel;
  partialRefund: CapabilityLevel;
  cancel: CapabilityLevel;
  webhooks: CapabilityLevel;
  redirectVerification: CapabilityLevel;
  methods: Partial<Record<PaymentMethod, CapabilityLevel>>;
  currencies: Currency[];
  checkoutKinds: CheckoutKind[];
  docsUrl: string;
}

export interface Ctx {
  http: HttpClient;
  logger: Logger;
  now(): Date;
  idempotency: IdempotencyStore;
}

export interface PaymentProvider<Id extends ProviderId = ProviderId> {
  readonly id: Id;
  readonly capabilities: Capabilities;

  createCheckout(input: CreateCheckoutInput<Id>, ctx: Ctx): Promise<Checkout>;
  getPayment(lookup: PaymentLookup, ctx: Ctx): Promise<Payment>;
  refund?(input: RefundInput, ctx: Ctx): Promise<Refund>;
  /** Void a same-day payment or cancel an unpaid reference code. */
  cancel?(lookup: PaymentLookup, ctx: Ctx): Promise<Payment>;

  inspectWebhook(req: RawWebhookRequest, ctx: Ctx): Promise<WebhookInspection>;
  /** Throws `WEBHOOK_SIGNATURE_INVALID` when the signature does not match. */
  verifyWebhook(req: RawWebhookRequest, ctx: Ctx): Promise<VerifiedWebhook>;
  parseWebhook(verified: VerifiedWebhook, ctx: Ctx): Promise<SarrafEvent>;
  verifyRedirect?(query: Record<string, string>, ctx: Ctx): Promise<RedirectResult>;
}

/** A row of a provider's status mapping table, exported for docs and the dashboard. */
export interface StatusMappingRow {
  provider: string;
  status: PaymentStatus;
  note?: string | undefined;
  verified: boolean;
}
