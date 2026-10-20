import {
  type Capabilities,
  type Checkout,
  type CreateCheckoutInput,
  type Ctx,
  type Payment,
  type PaymentLookup,
  type PaymentMethod,
  type PaymentProvider,
  type RedirectResult,
  type Refund,
  type RefundInput,
  SarrafError,
  type SarrafEvent,
  type VerifiedWebhook,
  type WebhookInspection,
  requireLookupKey,
  sarrafId,
} from "@sarraf/core";
import {
  type PaymobIntentionRequest,
  PaymobTokenCache,
  createIntention,
  getTransaction,
  getTransactionByReference,
  refundTransaction,
  unifiedCheckoutUrl,
  voidTransaction,
} from "./client.js";
import { type PaymobConfig, type PaymobOptions, resolveConfig } from "./config.js";
import { toPaymobPayment } from "./mappers.js";
import {
  inspectPaymobWebhook,
  parsePaymobWebhook,
  verifyPaymobRedirect,
  verifyPaymobWebhook,
} from "./webhooks.js";

export interface PaymobProviderOptions {
  /** Raw integration ids or method names, overriding `methods`. */
  paymentMethods?: (number | string)[] | undefined;
  /** Merged into the intention's `extras`. */
  extras?: Record<string, unknown> | undefined;
  /** Extra billing_data fields (street, city, country, …). */
  billingData?: Record<string, string> | undefined;
}

declare module "@sarraf/core" {
  interface ProviderOptionsRegistry {
    paymob: PaymobProviderOptions;
  }
}

export const PAYMOB_DOCS_URL = "https://sarraf.dev/providers/paymob";

export class PaymobProvider implements PaymentProvider<"paymob"> {
  readonly id = "paymob" as const;
  readonly capabilities: Capabilities;
  readonly config: PaymobConfig;
  private readonly tokens = new PaymobTokenCache();

  constructor(options: PaymobOptions) {
    this.config = resolveConfig(options);
    const methods: Capabilities["methods"] = {};
    for (const m of Object.keys(this.config.integrationIds) as PaymentMethod[]) methods[m] = "supported";
    this.capabilities = {
      checkout: "supported",
      getPayment: this.config.apiKey ? "supported" : "unsupported",
      refund: "supported",
      partialRefund: "supported",
      cancel: "supported",
      webhooks: "supported",
      redirectVerification: "supported",
      methods,
      currencies: [this.config.currency],
      checkoutKinds: ["redirect"],
      docsUrl: PAYMOB_DOCS_URL,
    };
  }

  /** The public key, for client-side Paymob Pixel. Safe to send to browsers. */
  get publicKey(): string {
    return this.config.publicKey;
  }

  async createCheckout(input: CreateCheckoutInput<"paymob">, ctx: Ctx): Promise<Checkout> {
    const cfg = this.config;
    const opts = input.providerOptions ?? {};
    const paymentMethods = opts.paymentMethods ?? this.integrationIdsFor(input.methods);
    const [first = "NA", ...rest] = (input.customer.name ?? "").trim().split(/\s+/).filter(Boolean);
    const body: PaymobIntentionRequest = {
      amount: input.amount.value,
      currency: input.amount.currency,
      payment_methods: paymentMethods,
      items: input.items?.length
        ? input.items.map((i) => ({ name: i.name, amount: i.unitAmount.value, quantity: i.quantity }))
        : [{ name: `Order ${input.reference}`, amount: input.amount.value, quantity: 1 }],
      billing_data: {
        first_name: first,
        last_name: rest.join(" ") || "NA",
        email: input.customer.email ?? "NA",
        phone_number: input.customer.phone,
        ...opts.billingData,
      },
      special_reference: input.reference,
      notification_url: input.webhookUrl,
      redirection_url: input.returnUrl,
      expiration: input.expiresInSeconds,
      extras: { sarraf_ref: input.reference, ...input.metadata, ...opts.extras },
    };
    const res = await createIntention(cfg, ctx, body);
    const now = ctx.now();
    const providerPaymentId = String(res.intention_order_id ?? res.id);
    const payment: Payment = {
      id: sarrafId("paymob", providerPaymentId),
      provider: "paymob",
      providerPaymentId,
      reference: input.reference,
      status: "pending",
      amount: input.amount,
      amountRefunded: { value: 0, currency: input.amount.currency },
      createdAt: now.toISOString(),
      raw: res,
    };
    return {
      id: sarrafId("paymob", res.id),
      provider: "paymob",
      kind: "redirect",
      redirectUrl: unifiedCheckoutUrl(cfg, res.client_secret),
      expiresAt: input.expiresInSeconds
        ? new Date(now.getTime() + input.expiresInSeconds * 1000).toISOString()
        : undefined,
      payment,
      raw: res,
    };
  }

  async getPayment(lookup: PaymentLookup, ctx: Ctx): Promise<Payment> {
    const txn = lookup.providerPaymentId
      ? await getTransaction(this.config, ctx, this.tokens, lookup.providerPaymentId)
      : await getTransactionByReference(this.config, ctx, this.tokens, requireLookupKey(lookup, "paymob"));
    return toPaymobPayment(txn, this.config.currency);
  }

  async refund(input: RefundInput, ctx: Ctx): Promise<Refund> {
    let amountCents = input.amount?.value;
    let original: Payment | undefined;
    if (amountCents === undefined) {
      original = await this.getPayment({ providerPaymentId: input.providerPaymentId }, ctx);
      amountCents = original.amount.value - original.amountRefunded.value;
      if (amountCents <= 0) {
        throw new SarrafError("INVALID_REQUEST", "paymob: nothing left to refund", { provider: "paymob" });
      }
    }
    const txn = await refundTransaction(this.config, ctx, input.providerPaymentId, amountCents);
    const currency = input.amount?.currency ?? original?.amount.currency ?? this.config.currency;
    return {
      id: sarrafId("paymob", txn.id ?? `refund_${input.providerPaymentId}`),
      provider: "paymob",
      providerRefundId: txn.id === undefined ? undefined : String(txn.id),
      providerPaymentId: input.providerPaymentId,
      status: txn.pending ? "pending" : txn.success ? "succeeded" : "failed",
      amount: { value: amountCents, currency },
      raw: txn,
    };
  }

  /** Void a same-day card payment (no amount). */
  async cancel(lookup: PaymentLookup, ctx: Ctx): Promise<Payment> {
    if (!lookup.providerPaymentId) {
      throw new SarrafError("INVALID_REQUEST", "paymob void needs providerPaymentId (transaction id)", {
        provider: "paymob",
      });
    }
    const txn = await voidTransaction(this.config, ctx, lookup.providerPaymentId);
    const payment = toPaymobPayment(txn, this.config.currency);
    return txn.success
      ? {
          ...payment,
          status: "canceled",
          providerPaymentId: lookup.providerPaymentId,
          id: sarrafId("paymob", lookup.providerPaymentId),
        }
      : payment;
  }

  async inspectWebhook(req: Parameters<PaymentProvider["inspectWebhook"]>[0]): Promise<WebhookInspection> {
    return inspectPaymobWebhook(this.config, req);
  }

  async verifyWebhook(req: Parameters<PaymentProvider["verifyWebhook"]>[0]): Promise<VerifiedWebhook> {
    return verifyPaymobWebhook(this.config, req);
  }

  async parseWebhook(
    verified: Parameters<PaymentProvider["parseWebhook"]>[0],
    ctx: Ctx,
  ): Promise<SarrafEvent> {
    return parsePaymobWebhook(this.config, verified, ctx);
  }

  async verifyRedirect(query: Record<string, string>): Promise<RedirectResult> {
    return verifyPaymobRedirect(this.config, query);
  }

  private integrationIdsFor(methods: PaymentMethod[] | undefined): number[] {
    const ids = this.config.integrationIds;
    if (!methods?.length) return Object.values(ids);
    return methods.map((m) => {
      const id = ids[m];
      if (!id) {
        throw new SarrafError(
          "CAPABILITY_NOT_SUPPORTED",
          `paymob: no integration id configured for method "${m}" (configured: ${Object.keys(ids).join(", ")})`,
          { provider: "paymob", docsUrl: PAYMOB_DOCS_URL },
        );
      }
      return id;
    });
  }
}
