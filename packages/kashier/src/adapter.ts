import {
  type Capabilities,
  type Checkout,
  type CreateCheckoutInput,
  type Ctx,
  type Payment,
  type PaymentLookup,
  type PaymentMethod,
  type PaymentProvider,
  type RawWebhookRequest,
  type RedirectResult,
  type Refund,
  type RefundInput,
  requireLookupKey,
  SarrafError,
  type SarrafEvent,
  sarrafId,
  str,
  type VerifiedWebhook,
  type WebhookInspection,
} from "@sarraf/core";
import { createSession, getOrder, refundOrder } from "./client.js";
import { type KashierConfig, type KashierOptions, resolveConfig } from "./config.js";
import { formatKashierAmount, KASHIER_METHOD_NAMES, toKashierPayment } from "./mappers.js";
import { kashierOrderHash } from "./signature.js";
import {
  inspectKashierWebhook,
  parseKashierWebhook,
  verifyKashierRedirectParams,
  verifyKashierWebhook,
} from "./webhooks.js";

export interface KashierProviderOptions {
  /** "hpp" (default): signed hosted payment page URL. "session": Payment Sessions API v3 (beta). */
  flow?: "hpp" | "session" | undefined;
  /** Saved-card customer reference, appended to the order hash. ⚠️ */
  customerReference?: string | undefined;
  /** Raw `allowedMethods` value, overriding `methods`. */
  allowedMethods?: string | undefined;
  /** Extra query params for the hosted page (e.g. brandColor). */
  extraParams?: Record<string, string> | undefined;
}

declare module "@sarraf/core" {
  interface ProviderOptionsRegistry {
    kashier: KashierProviderOptions;
  }
}

export const KASHIER_DOCS_URL = "https://sarraf.dev/providers/kashier";

export class KashierProvider implements PaymentProvider<"kashier"> {
  readonly id = "kashier" as const;
  readonly capabilities: Capabilities;
  readonly config: KashierConfig;

  constructor(options: KashierOptions) {
    this.config = resolveConfig(options);
    const server = this.config.secretKey ? "beta" : "unsupported";
    this.capabilities = {
      checkout: "supported",
      getPayment: server,
      refund: server,
      partialRefund: server,
      cancel: "unsupported",
      webhooks: "supported",
      redirectVerification: "supported",
      methods: { card: "supported", wallet: "supported", installments: "beta", bnpl: "beta" },
      currencies: this.config.currencies,
      checkoutKinds: ["redirect"],
      docsUrl: KASHIER_DOCS_URL,
    };
  }

  async createCheckout(input: CreateCheckoutInput<"kashier">, ctx: Ctx): Promise<Checkout> {
    const opts = input.providerOptions ?? {};
    const cfg = this.config;
    const amount = formatKashierAmount(input.amount.value, input.amount.currency, cfg);
    const allowedMethods = opts.allowedMethods ?? this.allowedMethods(input.methods);
    const now = ctx.now();
    const expiresAt = input.expiresInSeconds
      ? new Date(now.getTime() + input.expiresInSeconds * 1000).toISOString()
      : undefined;
    const payment: Payment = {
      id: sarrafId("kashier", input.reference),
      provider: "kashier",
      providerPaymentId: input.reference,
      reference: input.reference,
      status: "pending",
      amount: input.amount,
      amountRefunded: { value: 0, currency: input.amount.currency },
      createdAt: now.toISOString(),
      raw: undefined,
    };

    if (opts.flow === "session") {
      ctx.logger.warn("kashier: the Payment Sessions flow is beta in this version");
      const session = await createSession(cfg, ctx, {
        expireAt: expiresAt ?? new Date(now.getTime() + 3600_000).toISOString(),
        maxFailureAttempts: 3,
        paymentType: "credit",
        amount,
        currency: input.amount.currency,
        order: input.reference,
        merchantRedirect: input.returnUrl,
        serverWebhook: input.webhookUrl,
        failureRedirect: false,
        display: input.locale ?? "en",
        type: "one-time",
        allowedMethods,
        merchantId: cfg.merchantId,
        metaData: input.metadata,
        customer: input.customer.email
          ? { email: input.customer.email, reference: input.reference }
          : undefined,
      });
      return {
        id: sarrafId("kashier", session._id),
        provider: "kashier",
        kind: "redirect",
        redirectUrl: session.sessionUrl,
        expiresAt,
        payment: { ...payment, raw: session },
        raw: session,
      };
    }

    const hash = kashierOrderHash(
      {
        merchantId: cfg.merchantId,
        orderId: input.reference,
        amount,
        currency: input.amount.currency,
        customerReference: opts.customerReference,
      },
      cfg.apiKey,
    );
    const url = new URL(`${cfg.urls.checkout}/`);
    const params: Record<string, string | undefined> = {
      merchantId: cfg.merchantId,
      orderId: input.reference,
      amount,
      currency: input.amount.currency,
      hash,
      mode: cfg.mode,
      merchantRedirect: input.returnUrl,
      serverWebhook: input.webhookUrl,
      allowedMethods,
      display: input.locale ?? "en",
      customerReference: opts.customerReference,
      metaData: input.metadata ? JSON.stringify(input.metadata) : undefined,
      ...opts.extraParams,
    };
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    const raw = { hash, amount, orderId: input.reference };
    return {
      id: sarrafId("kashier", input.reference),
      provider: "kashier",
      kind: "redirect",
      redirectUrl: url.toString(),
      expiresAt,
      payment: { ...payment, raw },
      raw,
    };
  }

  /** ⚠️ Beta: order lookup endpoint to confirm. */
  async getPayment(lookup: PaymentLookup, ctx: Ctx): Promise<Payment> {
    const id = requireLookupKey(lookup, "kashier");
    const data = await getOrder(this.config, ctx, id);
    return toKashierPayment(data, "pay", this.config.currencies[0] ?? "EGP");
  }

  /** ⚠️ Beta: refund endpoint to confirm. `providerPaymentId` is the Kashier order id. */
  async refund(input: RefundInput, ctx: Ctx): Promise<Refund> {
    let amount = input.amount;
    if (!amount) {
      const current = await this.getPayment({ providerPaymentId: input.providerPaymentId }, ctx);
      amount = {
        value: current.amount.value - current.amountRefunded.value,
        currency: current.amount.currency,
      };
    }
    const res = await refundOrder(
      this.config,
      ctx,
      input.providerPaymentId,
      formatKashierAmount(amount.value, amount.currency, this.config),
      input.reason,
    );
    const response = (res.response ?? {}) as Record<string, unknown>;
    const status = (str(response.status) ?? str(res.status) ?? "").toUpperCase();
    const transactionId = str(response.transactionId);
    return {
      id: sarrafId("kashier", transactionId ?? `refund_${input.providerPaymentId}`),
      provider: "kashier",
      providerRefundId: transactionId,
      providerPaymentId: input.providerPaymentId,
      status: status === "SUCCESS" ? "succeeded" : status === "PENDING" ? "pending" : "failed",
      amount,
      raw: res,
    };
  }

  async inspectWebhook(req: RawWebhookRequest): Promise<WebhookInspection> {
    return inspectKashierWebhook(this.config, req);
  }

  async verifyWebhook(req: RawWebhookRequest): Promise<VerifiedWebhook> {
    return verifyKashierWebhook(this.config, req);
  }

  async parseWebhook(verified: VerifiedWebhook, ctx: Ctx): Promise<SarrafEvent> {
    return parseKashierWebhook(this.config, verified, ctx);
  }

  /** Pass the query in the order received (an object from Express keeps insertion order). */
  async verifyRedirect(query: Record<string, string>): Promise<RedirectResult> {
    return verifyKashierRedirectParams(this.config, query);
  }

  private allowedMethods(methods: PaymentMethod[] | undefined): string {
    const list = methods?.length ? methods : (["card", "wallet"] as PaymentMethod[]);
    return list
      .map((m) => {
        const name = KASHIER_METHOD_NAMES[m];
        if (!name) {
          throw new SarrafError("CAPABILITY_NOT_SUPPORTED", `kashier does not support method "${m}"`, {
            provider: "kashier",
            docsUrl: KASHIER_DOCS_URL,
          });
        }
        return name;
      })
      .join(",");
  }
}
