import {
  type Capabilities,
  type Checkout,
  type CreateCheckoutInput,
  type Ctx,
  type Money,
  type Payment,
  type PaymentLookup,
  type PaymentMethod,
  type PaymentProvider,
  type RawWebhookRequest,
  type RedirectResult,
  type Refund,
  type RefundInput,
  SarrafError,
  type SarrafEvent,
  sarrafId,
  str,
  type VerifiedWebhook,
  type WebhookInspection,
} from "@sarrafjs/core";
import { createSession, findOrder, refundOrder, voidOrder } from "./client.js";
import { type KashierConfig, type KashierOptions, resolveConfig } from "./config.js";
import { formatKashierAmount, KASHIER_METHOD_NAMES, toKashierOrderPayment } from "./mappers.js";
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

declare module "@sarrafjs/core" {
  interface ProviderOptionsRegistry {
    kashier: KashierProviderOptions;
  }
}

export const KASHIER_DOCS_URL = "https://sarraf.dev/providers/kashier";

/** Refund outcomes that mean the money went back. */
const REFUND_SUCCEEDED = new Set(["SUCCESS", "PARTIALLY_REFUNDED", "REFUNDED"]);

export class KashierProvider implements PaymentProvider<"kashier"> {
  readonly id = "kashier" as const;
  readonly capabilities: Capabilities;
  readonly config: KashierConfig;

  constructor(options: KashierOptions) {
    this.config = resolveConfig(options);
    // Order lookup, partial and full refunds and voids are confirmed in the sandbox (fixtures/kashier/sandbox-*).
    const server = this.config.secretKey ? "supported" : "unsupported";
    this.capabilities = {
      checkout: "supported",
      getPayment: server,
      refund: server,
      partialRefund: server,
      cancel: server,
      webhooks: "supported",
      capture: "unsupported",
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

  /**
   * Looks the order up by `reference` (your merchantOrderId). Kashier's order search does not
   * accept its own order id, so a `providerPaymentId`-only lookup is rejected.
   */
  async getPayment(lookup: PaymentLookup, ctx: Ctx): Promise<Payment> {
    if (!lookup.reference) {
      throw new SarrafError(
        "INVALID_REQUEST",
        "kashier: look payments up by `reference` (your merchantOrderId). Kashier's order search does not accept its own order id.",
        { provider: "kashier", docsUrl: KASHIER_DOCS_URL },
      );
    }
    const order = await findOrder(this.config, ctx, lookup.reference);
    return toKashierOrderPayment(order, this.config.currencies[0] ?? "EGP");
  }

  /**
   * `providerPaymentId` is the Kashier order id. For a full refund omit `amount` and pass `reference`:
   * Kashier answers HTTP 500 to a refund without an amount (sandbox, 2026-10-21), so the remaining
   * amount is read from the order lookup, which only searches by reference.
   */
  async refund(input: RefundInput, ctx: Ctx): Promise<Refund> {
    const amount = input.amount ?? (await this.remainingAmount(input, ctx));
    const res = await refundOrder(
      this.config,
      ctx,
      input.providerPaymentId,
      formatKashierAmount(amount.value, amount.currency, this.config),
      input.reason,
    );
    const response = (res.response ?? {}) as Record<string, unknown>;
    // `response.result` is the refund's own outcome. `response.status` is the order's new state
    // (PARTIALLY_REFUNDED / REFUNDED after a successful refund), so it must not be read as a failure:
    // a refund wrongly reported as failed invites a second refund. Recorded in
    // fixtures/kashier/sandbox-refund-partial-succeeded.json.
    const outcome = (str(response.result) ?? str(res.status) ?? str(response.status) ?? "").toUpperCase();
    const status = REFUND_SUCCEEDED.has(outcome) ? "succeeded" : outcome === "PENDING" ? "pending" : "failed";
    const transactionId = str(response.transactionId);
    return {
      id: sarrafId("kashier", transactionId ?? `refund_${input.providerPaymentId}`),
      provider: "kashier",
      providerRefundId: transactionId,
      providerPaymentId: input.providerPaymentId,
      status,
      amount,
      raw: res,
    };
  }

  /** What is left to refund on the order, from the order lookup. */
  /**
   * Voids the order's successful pay transaction (same day only; use a refund after that). Confirmed in
   * the sandbox (fixtures/kashier/sandbox-void-succeeded.json).
   * Needs `reference` to find the pay transaction, and returns the order as Kashier reports it after
   * the void.
   */
  async cancel(lookup: PaymentLookup, ctx: Ctx): Promise<Payment> {
    const payment = await this.getPayment(lookup, ctx);
    if (lookup.providerPaymentId && lookup.providerPaymentId !== payment.providerPaymentId) {
      throw new SarrafError(
        "INVALID_REQUEST",
        `kashier: reference "${payment.reference}" belongs to order ${payment.providerPaymentId}, not ${lookup.providerPaymentId}`,
        { provider: "kashier" },
      );
    }
    const raw = payment.raw as { transactions?: unknown };
    const transactions = Array.isArray(raw.transactions)
      ? (raw.transactions as Record<string, unknown>[])
      : [];
    const pay = [...transactions]
      .reverse()
      .find((t) => str(t.operation)?.toLowerCase() === "pay" && str(t.status)?.toUpperCase() === "SUCCESS");
    const target = str(pay?.transactionId);
    if (!target) {
      throw new SarrafError(
        "INVALID_REQUEST",
        `kashier: order "${payment.reference}" has no successful pay to void`,
        {
          provider: "kashier",
        },
      );
    }
    const res = await voidOrder(
      this.config,
      ctx,
      payment.providerPaymentId,
      target,
      formatKashierAmount(payment.amount.value, payment.amount.currency, this.config),
    );
    const response = (res.response ?? {}) as Record<string, unknown>;
    const outcome = (str(response.result) ?? str(res.status) ?? "").toUpperCase();
    if (outcome !== "SUCCESS") {
      throw new SarrafError(
        "PAYMENT_DECLINED",
        `kashier: void was not accepted (${outcome || "no result"})`,
        {
          provider: "kashier",
          raw: res,
        },
      );
    }
    return this.getPayment({ reference: payment.reference }, ctx);
  }

  private async remainingAmount(input: RefundInput, ctx: Ctx): Promise<Money> {
    if (!input.reference) {
      throw new SarrafError(
        "INVALID_REQUEST",
        "kashier: a full refund needs `reference` (your merchantOrderId) so Sarraf can look up the remaining amount, or pass `amount`.",
        { provider: "kashier", docsUrl: KASHIER_DOCS_URL },
      );
    }
    const order = await this.getPayment({ reference: input.reference }, ctx);
    if (order.providerPaymentId !== input.providerPaymentId) {
      throw new SarrafError(
        "INVALID_REQUEST",
        `kashier: reference "${input.reference}" belongs to order ${order.providerPaymentId}, not ${input.providerPaymentId}`,
        { provider: "kashier" },
      );
    }
    const remaining = order.amount.value - order.amountRefunded.value;
    if (remaining <= 0) {
      throw new SarrafError(
        "INVALID_REQUEST",
        `kashier: order "${input.reference}" is already fully refunded`,
        {
          provider: "kashier",
        },
      );
    }
    return { value: remaining, currency: order.amount.currency };
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
