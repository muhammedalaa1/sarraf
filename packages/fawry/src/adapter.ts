import {
  type Capabilities,
  type Checkout,
  type CreateCheckoutInput,
  type Ctx,
  type Payment,
  type PaymentLookup,
  type PaymentProvider,
  type RawWebhookRequest,
  type Refund,
  type RefundInput,
  requireLookupKey,
  SarrafError,
  type SarrafEvent,
  sarrafId,
  str,
  toMajorFixed,
  type VerifiedWebhook,
  type WebhookInspection,
} from "@sarraf/core";
import { cancelUnpaid, charge, expressInit, type FawryChargeItem, getStatus, refund } from "./client.js";
import { type FawryConfig, type FawryOptions, resolveConfig } from "./config.js";
import { toFawryMobile, toFawryPayment } from "./mappers.js";
import { inspectFawryWebhook, parseFawryWebhook, verifyFawryWebhook } from "./webhooks.js";

export interface FawryProviderOptions {
  /** Your stable customer id, sent as customerProfileId (covered by the signature). */
  customerProfileId?: string | undefined;
  /** Order description shown by Fawry. Default "Order <reference>". */
  description?: string | undefined;
}

declare module "@sarraf/core" {
  interface ProviderOptionsRegistry {
    fawry: FawryProviderOptions;
  }
}

export const FAWRY_DOCS_URL = "https://sarraf.dev/providers/fawry";

export class FawryProvider implements PaymentProvider<"fawry"> {
  readonly id = "fawry" as const;
  readonly config: FawryConfig;
  readonly capabilities: Capabilities = {
    checkout: "supported",
    getPayment: "supported",
    refund: "beta",
    partialRefund: "beta",
    cancel: "beta",
    webhooks: "supported",
    capture: "unsupported",
    redirectVerification: "unsupported",
    methods: { cash_outlet: "supported", card: "beta", wallet: "beta" },
    currencies: ["EGP"],
    checkoutKinds: ["reference_code", "redirect"],
    docsUrl: FAWRY_DOCS_URL,
  };

  constructor(options: FawryOptions) {
    this.config = resolveConfig(options);
  }

  async createCheckout(input: CreateCheckoutInput<"fawry">, ctx: Ctx): Promise<Checkout> {
    const opts = input.providerOptions ?? {};
    const methods = input.methods ?? ["cash_outlet"];
    const hosted = methods.some((m) => m === "card" || m === "wallet");
    if (hosted && methods.includes("cash_outlet")) {
      throw new SarrafError(
        "INVALID_REQUEST",
        'fawry: create cash ("cash_outlet") and hosted card/wallet checkouts separately',
        { provider: "fawry" },
      );
    }
    const now = ctx.now();
    const paymentExpiry = input.expiresInSeconds ? now.getTime() + input.expiresInSeconds * 1000 : undefined;
    const chargeItems: FawryChargeItem[] = input.items?.length
      ? input.items.map((item, i) => ({
          itemId: item.sku ?? `item${i + 1}`,
          description: item.name,
          price: Number(toMajorFixed(item.unitAmount.value, item.unitAmount.currency, 2)),
          quantity: item.quantity,
        }))
      : [
          {
            itemId: input.reference,
            description: opts.description ?? `Order ${input.reference}`,
            price: Number(toMajorFixed(input.amount.value, input.amount.currency, 2)),
            quantity: 1,
          },
        ];
    const common = {
      merchantRefNum: input.reference,
      customerProfileId: opts.customerProfileId,
      customerName: input.customer.name,
      customerMobile: toFawryMobile(input.customer.phone),
      customerEmail: input.customer.email,
      paymentExpiry,
      language: input.locale === "ar" ? "ar-eg" : this.config.language,
    };
    const basePayment = (providerPaymentId: string, status: Payment["status"], raw: unknown): Payment => ({
      id: sarrafId("fawry", providerPaymentId),
      provider: "fawry",
      providerPaymentId,
      reference: input.reference,
      status,
      amount: input.amount,
      amountRefunded: { value: 0, currency: input.amount.currency },
      method: hosted ? (methods[0] === "wallet" ? "wallet" : "card") : "cash_outlet",
      createdAt: now.toISOString(),
      raw,
    });

    if (hosted) {
      if (!input.returnUrl) {
        throw new SarrafError("INVALID_REQUEST", "fawry hosted checkout needs returnUrl", {
          provider: "fawry",
        });
      }
      const url = await expressInit(this.config, ctx, {
        ...common,
        returnUrl: input.returnUrl,
        chargeItems,
        paymentMethod: methods.length === 1 ? (methods[0] === "wallet" ? "MWALLET" : "CARD") : undefined,
        authCaptureModePayment: false,
      });
      return {
        id: sarrafId("fawry", input.reference),
        provider: "fawry",
        kind: "redirect",
        redirectUrl: url,
        expiresAt: paymentExpiry ? new Date(paymentExpiry).toISOString() : undefined,
        payment: basePayment(input.reference, "pending", { url }),
        raw: { url },
      };
    }

    const res = await charge(this.config, ctx, {
      ...common,
      paymentMethod: "PAYATFAWRY",
      amount: toMajorFixed(input.amount.value, input.amount.currency, 2),
      currencyCode: "EGP",
      description: opts.description ?? `Order ${input.reference}`,
      chargeItems,
    });
    const referenceCode = str(res.referenceNumber);
    if (!referenceCode) {
      throw new SarrafError("PROVIDER_UNAVAILABLE", "fawry charge returned no referenceNumber", {
        provider: "fawry",
        raw: res,
      });
    }
    const expiresAt = res.expirationTime
      ? new Date(Number(res.expirationTime)).toISOString()
      : paymentExpiry
        ? new Date(paymentExpiry).toISOString()
        : undefined;
    return {
      id: sarrafId("fawry", referenceCode),
      provider: "fawry",
      kind: "reference_code",
      referenceCode,
      expiresAt,
      payment: basePayment(referenceCode, "awaiting_payment", res),
      raw: res,
    };
  }

  /** Status v2 looks up by merchant reference. */
  async getPayment(lookup: PaymentLookup, ctx: Ctx): Promise<Payment> {
    if (!lookup.reference) {
      throw new SarrafError("INVALID_REQUEST", "fawry status lookup needs the merchant reference", {
        provider: "fawry",
      });
    }
    return toFawryPayment(await getStatus(this.config, ctx, lookup.reference));
  }

  /** ⚠️ Beta. `providerPaymentId` is the Fawry reference number. */
  async refund(input: RefundInput, ctx: Ctx): Promise<Refund> {
    let amount = input.amount;
    if (!amount) {
      if (!input.reference) {
        throw new SarrafError("INVALID_REQUEST", "fawry full refund needs amount or the merchant reference", {
          provider: "fawry",
        });
      }
      const p = await this.getPayment({ reference: input.reference }, ctx);
      amount = { value: p.amount.value - p.amountRefunded.value, currency: p.amount.currency };
    }
    const res = await refund(this.config, ctx, {
      referenceNumber: input.providerPaymentId,
      refundAmount: toMajorFixed(amount.value, amount.currency, 2),
      reason: input.reason,
    });
    return {
      id: sarrafId("fawry", `refund_${input.providerPaymentId}_${amount.value}`),
      provider: "fawry",
      providerPaymentId: input.providerPaymentId,
      status: "succeeded",
      amount,
      raw: res,
    };
  }

  /** ⚠️ Beta. Cancel an unpaid reference code. */
  async cancel(lookup: PaymentLookup, ctx: Ctx): Promise<Payment> {
    const ref = requireLookupKey(lookup, "fawry");
    await cancelUnpaid(this.config, ctx, ref);
    if (lookup.reference) return this.getPayment({ reference: lookup.reference }, ctx);
    return {
      id: sarrafId("fawry", ref),
      provider: "fawry",
      providerPaymentId: ref,
      reference: "",
      status: "canceled",
      amount: { value: 0, currency: "EGP" },
      amountRefunded: { value: 0, currency: "EGP" },
      raw: undefined,
    };
  }

  async inspectWebhook(req: RawWebhookRequest): Promise<WebhookInspection> {
    return inspectFawryWebhook(this.config, req);
  }

  async verifyWebhook(req: RawWebhookRequest): Promise<VerifiedWebhook> {
    return verifyFawryWebhook(this.config, req);
  }

  async parseWebhook(verified: VerifiedWebhook, ctx: Ctx): Promise<SarrafEvent> {
    return parseFawryWebhook(this.config, verified, ctx);
  }
}
