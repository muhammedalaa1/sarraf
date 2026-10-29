import {
  type Capabilities,
  type CapabilityLevel,
  type CaptureInput,
  type Checkout,
  type CheckoutKind,
  type CreateCheckoutInput,
  type Ctx,
  type Payment,
  type PaymentLookup,
  type PaymentMethod,
  type PaymentProvider,
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
} from "@sarrafjs/core";
import {
  captureTransaction,
  createIntention,
  getTransaction,
  getTransactionByReference,
  type PaymobIntentionResponse,
  PaymobTokenCache,
  payWithSource,
  refundTransaction,
  unifiedCheckoutUrl,
  voidTransaction,
} from "./client.js";
import { type PaymobConfig, type PaymobIntegration, type PaymobOptions, resolveConfig } from "./config.js";
import { PaymobExtras } from "./extras/index.js";
import { intentionBody } from "./intention.js";
import { type PaymobTransaction, toPaymobPayment, truthy } from "./mappers.js";
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
  /**
   * `"manual"` authorizes the card only (needs `integrationIds.card_auth`); capture it later with
   * `pay.payments.capture(...)`. Uncaptured authorizations are voided by Paymob after 14 days.
   */
  capture?: "manual" | undefined;
  /** Saved card tokens (from `card.saved` events) offered on the checkout, max 3. */
  cardTokens?: string[] | undefined;
  /** Start a subscription on this plan with the first (3DS) payment. */
  subscription?: { planId: number; startDate?: string | undefined } | undefined;
  /** Add the card used on this checkout to an existing subscription, as a secondary card. */
  addCardToSubscription?: number | undefined;
}

declare module "@sarrafjs/core" {
  interface ProviderOptionsRegistry {
    paymob: PaymobProviderOptions;
  }
}

export const PAYMOB_DOCS_URL = "https://sarraf.dev/providers/paymob";

/** Integrations that are not offered as their own method on the Unified Checkout. */
const NOT_ON_CHECKOUT = new Set<PaymobIntegration>(["card_auth", "card_moto", "cash_outlet"]);

/** Methods confirmed against the Paymob sandbox. Everything else ships as beta. */
const VERIFIED_METHODS = new Set<PaymentMethod>(["card", "wallet"]);

export class PaymobProvider implements PaymentProvider<"paymob"> {
  readonly id = "paymob" as const;
  readonly capabilities: Capabilities;
  readonly config: PaymobConfig;
  private readonly tokens = new PaymobTokenCache();
  private ctx: Ctx | undefined;
  private extrasApi: PaymobExtras | undefined;

  constructor(options: PaymobOptions) {
    this.config = resolveConfig(options);
    const ids = this.config.integrationIds;
    const methods: Capabilities["methods"] = {};
    for (const key of Object.keys(ids) as PaymobIntegration[]) {
      if (key === "card_auth" || key === "card_moto" || key === "apple_pay") continue;
      methods[key] = VERIFIED_METHODS.has(key) ? "supported" : "beta";
    }
    const server: CapabilityLevel = this.config.apiKey ? "supported" : "unsupported";
    const checkoutKinds: CheckoutKind[] = [];
    if (Object.keys(ids).some((k) => !NOT_ON_CHECKOUT.has(k as PaymobIntegration)))
      checkoutKinds.push("redirect");
    if (ids.cash_outlet) checkoutKinds.push("reference_code");
    this.capabilities = {
      checkout: "supported",
      getPayment: server,
      refund: "supported",
      partialRefund: "supported",
      cancel: "supported",
      capture: ids.card_auth ? "beta" : "unsupported",
      webhooks: "supported",
      redirectVerification: "supported",
      methods,
      currencies: [this.config.currency],
      checkoutKinds,
      docsUrl: PAYMOB_DOCS_URL,
    };
  }

  /** The public key, for client-side Paymob Pixel. Safe to send to browsers. */
  get publicKey(): string {
    return this.config.publicKey;
  }

  attach(ctx: Ctx): void {
    this.ctx = ctx;
  }

  /**
   * Paymob features beyond the shared API: saved cards, subscriptions, payment links and
   * intention updates. Available once the adapter is passed to `new Sarraf(...)`.
   */
  get extras(): PaymobExtras {
    this.extrasApi ??= new PaymobExtras({
      provider: this,
      config: this.config,
      tokens: this.tokens,
      ctx: () => {
        if (!this.ctx) {
          throw new SarrafError(
            "CONFIGURATION_INVALID",
            "paymob extras need the adapter registered with new Sarraf({ providers: { paymob } })",
            { provider: "paymob" },
          );
        }
        return this.ctx;
      },
    });
    return this.extrasApi;
  }

  /**
   * Hosted Unified Checkout, or a kiosk bill reference when `methods` is `["cash_outlet"]`.
   *
   * `payment.providerPaymentId` is empty until Paymob creates the transaction: the id arrives with
   * the webhook or `payments.reconcile`. Refunds, voids and captures need that transaction id.
   */
  async createCheckout(input: CreateCheckoutInput<"paymob">, ctx: Ctx): Promise<Checkout> {
    const opts = input.providerOptions ?? {};
    const kiosk = input.methods?.includes("cash_outlet") ?? false;
    if (kiosk && input.methods && input.methods.length > 1) {
      throw new SarrafError(
        "INVALID_REQUEST",
        "paymob: cash_outlet (kiosk) returns a bill reference and cannot be combined with other methods",
        { provider: "paymob" },
      );
    }
    const paymentMethods =
      opts.paymentMethods ??
      (kiosk
        ? [this.integrationId("cash_outlet")]
        : this.integrationIdsFor(input.methods, opts.capture === "manual"));
    const res = await createIntention(this.config, ctx, intentionBody(input, paymentMethods));
    if (kiosk) return this.kioskCheckout(input, res, ctx);
    const now = ctx.now();
    return {
      id: sarrafId("paymob", res.id),
      provider: "paymob",
      kind: "redirect",
      redirectUrl: unifiedCheckoutUrl(this.config, res.client_secret),
      expiresAt: expiresAt(input, now),
      payment: {
        id: sarrafId("paymob", res.id),
        provider: "paymob",
        providerPaymentId: "",
        reference: input.reference,
        status: "pending",
        amount: input.amount,
        amountRefunded: { value: 0, currency: input.amount.currency },
        createdAt: now.toISOString(),
        raw: res,
      },
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
      if (!this.config.apiKey) {
        throw new SarrafError(
          "CONFIGURATION_INVALID",
          "paymob: a full refund needs apiKey to read the remaining amount; pass `amount` instead",
          { provider: "paymob", docsUrl: PAYMOB_DOCS_URL },
        );
      }
      original = await this.getPayment({ providerPaymentId: input.providerPaymentId }, ctx);
      if (original.method === "cash_outlet") {
        throw new SarrafError("CAPABILITY_NOT_SUPPORTED", "paymob: kiosk payments cannot be refunded", {
          provider: "paymob",
          docsUrl: PAYMOB_DOCS_URL,
        });
      }
      amountCents = original.amount.value - original.amountRefunded.value;
      if (amountCents <= 0) {
        throw new SarrafError("INVALID_REQUEST", "paymob: nothing left to refund", { provider: "paymob" });
      }
    }
    const txn = await refundTransaction(this.config, ctx, input.providerPaymentId, amountCents);
    const currency = input.amount?.currency ?? original?.amount.currency ?? this.config.currency;
    const status = txn.pending ? "pending" : txn.success ? "succeeded" : "failed";
    return {
      id: sarrafId("paymob", txn.id ?? `refund_${input.providerPaymentId}`),
      provider: "paymob",
      providerRefundId: txn.id === undefined ? undefined : String(txn.id),
      providerPaymentId: input.providerPaymentId,
      status,
      amount: { value: amountCents, currency },
      payment: status === "failed" ? undefined : await this.paymentAfter(input.providerPaymentId, ctx),
      raw: txn,
    };
  }

  /** Void a same-day card payment (no amount). Looks the transaction up by reference when needed. */
  async cancel(lookup: PaymentLookup, ctx: Ctx): Promise<Payment> {
    const id =
      lookup.providerPaymentId ??
      String(
        (await getTransactionByReference(this.config, ctx, this.tokens, requireLookupKey(lookup, "paymob")))
          .id,
      );
    const txn = await voidTransaction(this.config, ctx, id);
    if (!truthy(txn.success)) throw declined("void", txn);
    return {
      ...toPaymobPayment(txn, this.config.currency),
      status: "canceled",
      providerPaymentId: id,
      id: sarrafId("paymob", id),
    };
  }

  /** Capture an authorization made with `providerOptions.capture: "manual"`. */
  async capture(input: CaptureInput, ctx: Ctx): Promise<Payment> {
    let amountCents = input.amount?.value;
    if (amountCents === undefined) {
      if (!this.config.apiKey) {
        throw new SarrafError(
          "CONFIGURATION_INVALID",
          "paymob: capturing the full amount needs apiKey to read the authorization; pass `amount` instead",
          { provider: "paymob", docsUrl: PAYMOB_DOCS_URL },
        );
      }
      amountCents = (await this.getPayment({ providerPaymentId: input.providerPaymentId }, ctx)).amount.value;
    }
    const txn = await captureTransaction(this.config, ctx, input.providerPaymentId, amountCents);
    if (!truthy(txn.success) && !truthy(txn.pending)) throw declined("capture", txn);
    return {
      ...toPaymobPayment(txn, this.config.currency),
      status: truthy(txn.pending) ? "pending" : "succeeded",
      providerPaymentId: input.providerPaymentId,
      id: sarrafId("paymob", input.providerPaymentId),
    };
  }

  async inspectWebhook(req: Parameters<PaymentProvider["inspectWebhook"]>[0]): Promise<WebhookInspection> {
    return inspectPaymobWebhook(this.config, req);
  }

  async verifyWebhook(req: Parameters<PaymentProvider["verifyWebhook"]>[0]): Promise<VerifiedWebhook> {
    return verifyPaymobWebhook(this.config, req);
  }

  async parseWebhook(verified: VerifiedWebhook, ctx: Ctx): Promise<SarrafEvent> {
    const lookup = this.config.apiKey
      ? async (id: string) => this.getPayment({ providerPaymentId: id }, ctx)
      : undefined;
    return parsePaymobWebhook(this.config, verified, ctx, lookup);
  }

  async verifyRedirect(query: Record<string, string>): Promise<RedirectResult> {
    return verifyPaymobRedirect(this.config, query);
  }

  /** Configured id for `key`, or `CAPABILITY_NOT_SUPPORTED`. */
  integrationId(key: PaymobIntegration): number {
    const id = this.config.integrationIds[key];
    if (!id) {
      throw new SarrafError(
        "CAPABILITY_NOT_SUPPORTED",
        `paymob: no integration id configured for "${key}" (configured: ${Object.keys(this.config.integrationIds).join(", ")})`,
        { provider: "paymob", docsUrl: PAYMOB_DOCS_URL },
      );
    }
    return id;
  }

  private integrationIdsFor(methods: PaymentMethod[] | undefined, manualCapture: boolean): number[] {
    if (manualCapture) {
      if (methods?.some((m) => m !== "card")) {
        throw new SarrafError("INVALID_REQUEST", 'paymob: capture: "manual" is for card payments only', {
          provider: "paymob",
        });
      }
      return [this.integrationId("card_auth")];
    }
    const ids = this.config.integrationIds;
    const keys: PaymobIntegration[] = methods?.length
      ? methods.flatMap((m): PaymobIntegration[] =>
          m === "card" && ids.apple_pay ? ["card", "apple_pay"] : [m],
        )
      : (Object.keys(ids) as PaymobIntegration[]).filter((k) => !NOT_ON_CHECKOUT.has(k));
    return keys.map((k) => this.integrationId(k));
  }

  /** Kiosk (Aman / Masary): pay the intention's payment key with the aggregator source. */
  private async kioskCheckout(
    input: CreateCheckoutInput<"paymob">,
    res: PaymobIntentionResponse,
    ctx: Ctx,
  ): Promise<Checkout> {
    const kioskId = this.integrationId("cash_outlet");
    const key = res.payment_keys?.find((k) => k.integration === kioskId) ?? res.payment_keys?.[0];
    if (!key) {
      throw new SarrafError(
        "PROVIDER_UNAVAILABLE",
        "paymob: the intention returned no payment key for kiosk",
        {
          provider: "paymob",
          raw: res,
        },
      );
    }
    const txn = await payWithSource(this.config, ctx, key.key, {
      identifier: "AGGREGATOR",
      subtype: "AGGREGATOR",
    });
    const referenceCode =
      str(txn.data?.bill_reference) ?? str((txn as Record<string, unknown>).bill_reference);
    if (!referenceCode) {
      throw new SarrafError("PROVIDER_UNAVAILABLE", "paymob: kiosk payment returned no bill reference", {
        provider: "paymob",
        raw: txn,
      });
    }
    const mapped = toPaymobPayment(txn, this.config.currency);
    const payment: Payment = {
      ...mapped,
      reference: mapped.reference || input.reference,
      amount: input.amount,
      method: "cash_outlet",
      status: mapped.status === "pending" ? "awaiting_payment" : mapped.status,
      raw: { intention: res, transaction: txn },
    };
    return {
      id: sarrafId("paymob", res.id),
      provider: "paymob",
      kind: "reference_code",
      referenceCode,
      expiresAt: expiresAt(input, ctx.now()),
      payment,
      raw: payment.raw,
    };
  }

  /** The original payment after a refund, with its new totals. Undefined without an apiKey. */
  private async paymentAfter(providerPaymentId: string, ctx: Ctx): Promise<Payment | undefined> {
    if (!this.config.apiKey) return undefined;
    return this.getPayment({ providerPaymentId }, ctx).catch((err: unknown) => {
      ctx.logger.warn("paymob: could not re-read the payment after refund", { error: String(err) });
      return undefined;
    });
  }
}

/** Unified Checkout / Pixel parameters of a redirect checkout, for embedding Paymob Pixel. */
export function paymobEmbed(checkout: Checkout): { publicKey: string; clientSecret: string } {
  const url = checkout.redirectUrl ? new URL(checkout.redirectUrl) : undefined;
  const publicKey = url?.searchParams.get("publicKey");
  const clientSecret = url?.searchParams.get("clientSecret");
  if (checkout.provider !== "paymob" || !publicKey || !clientSecret) {
    throw new SarrafError("INVALID_REQUEST", "paymobEmbed needs a Paymob redirect checkout", {
      provider: "paymob",
    });
  }
  return { publicKey, clientSecret };
}

function expiresAt(input: CreateCheckoutInput, now: Date): string | undefined {
  return input.expiresInSeconds
    ? new Date(now.getTime() + input.expiresInSeconds * 1000).toISOString()
    : undefined;
}

function declined(operation: string, txn: PaymobTransaction): SarrafError {
  return new SarrafError(
    "PAYMENT_DECLINED",
    `paymob ${operation} was not accepted: ${str(txn.data?.message) ?? "no reason given"}`,
    { provider: "paymob", raw: txn },
  );
}
