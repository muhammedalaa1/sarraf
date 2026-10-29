import { type Money, moneySchema, type PaymentMethod, str, validateWith } from "@sarrafjs/core";
import { z } from "zod";
import { authedRequest, toId } from "../client.js";
import type { ExtrasDeps } from "./index.js";

const linkSchema = z.object({
  amount: moneySchema.refine((m) => m.value > 0, "must be greater than zero"),
  /** Must be unique per link. Comes back as `merchant_order_id` on the transaction. */
  reference: z.string().min(1).max(200),
  /** Methods (resolved through `integrationIds`) or raw integration ids. Defaults to `card`. */
  methods: z
    .array(z.union([z.string(), z.number().int().positive()]))
    .nonempty()
    .optional(),
  expiresAt: z.union([z.date(), z.string().datetime({ offset: true })]).optional(),
  customer: z
    .object({
      name: z.string().optional(),
      /** Paymob emails the link when set. */
      email: z.string().email().optional(),
      /** Paymob texts the link when set. */
      phone: z.string().optional(),
    })
    .optional(),
  description: z.string().max(500).optional(),
  notificationUrl: z.string().url().optional(),
  redirectionUrl: z.string().url().optional(),
  /** Ask the customer for these on the link page. */
  collect: z
    .object({
      phone: z.boolean().optional(),
      email: z.boolean().optional(),
      name: z.boolean().optional(),
      billing: z.boolean().optional(),
      shipping: z.boolean().optional(),
    })
    .optional(),
  /** ISO country codes allowed for shipping. */
  allowedCountries: z.array(z.string().length(2)).optional(),
});

export type PaymobLinkInput = Omit<z.input<typeof linkSchema>, "amount" | "methods"> & {
  amount: Money;
  methods?: (PaymentMethod | number)[] | undefined;
};

export interface PaymobPaymentLink {
  id: number;
  /** Checkout page to send the customer to. */
  url: string;
  shortUrl?: string | undefined;
  /** `"created"`, `"paid"`, `"canceled"`, … */
  state?: string | undefined;
  reference: string;
  amount: Money;
  expiresAt?: string | undefined;
  raw: unknown;
}

interface PaymobLinkResponse {
  id: number;
  client_url?: string;
  shorten_url?: string;
  state?: string;
  expires_at?: string;
  [k: string]: unknown;
}

export class PaymobLinks {
  constructor(private readonly deps: ExtrasDeps) {}

  /** Create a shareable payment link. Its payment arrives as an ordinary transaction callback. */
  async create(input: PaymobLinkInput): Promise<PaymobPaymentLink> {
    const v = validateWith(linkSchema, input, "paymob.links.create");
    const { config, provider } = this.deps;
    const form = new FormData();
    form.append("amount_cents", String(v.amount.value));
    for (const m of v.methods ?? ["card"]) {
      form.append(
        "payment_methods",
        String(typeof m === "number" ? m : provider.integrationId(m as PaymentMethod)),
      );
    }
    form.append("is_live", String(config.mode === "live"));
    form.append("reference_id", v.reference);
    if (v.expiresAt) form.append("expires_at", new Date(v.expiresAt).toISOString());
    const optional: [string, string | undefined][] = [
      ["full_name", v.customer?.name],
      ["email", v.customer?.email],
      ["phone_number", v.customer?.phone],
      ["description", v.description],
      ["notification_url", v.notificationUrl],
      ["redirection_url", v.redirectionUrl],
      ["collect_phone_number", flag(v.collect?.phone)],
      ["collect_email_address", flag(v.collect?.email)],
      ["collect_customer_name", flag(v.collect?.name)],
      ["collect_billing_details", flag(v.collect?.billing)],
      ["collect_shipping_details", flag(v.collect?.shipping)],
    ];
    for (const [k, value] of optional) if (value !== undefined) form.append(k, value);
    for (const c of v.allowedCountries ?? []) form.append("allowed_countries", c);

    const res = await authedRequest<PaymobLinkResponse>(config, this.deps.ctx(), this.deps.tokens, {
      method: "POST",
      url: `${config.baseUrl}/api/ecommerce/payment-links`,
      body: form,
      operation: "createPaymentLink",
    });
    return {
      id: res.id,
      url: str(res.client_url) ?? "",
      shortUrl: str(res.shorten_url),
      state: str(res.state),
      reference: v.reference,
      amount: v.amount,
      expiresAt: str(res.expires_at),
      raw: res,
    };
  }

  /** Cancel an unpaid link. */
  async cancel(linkId: number): Promise<unknown> {
    const form = new FormData();
    form.append("payment_link_id", String(toId(linkId)));
    return authedRequest<unknown>(this.deps.config, this.deps.ctx(), this.deps.tokens, {
      method: "POST",
      url: `${this.deps.config.baseUrl}/api/ecommerce/payment-links/cancel`,
      body: form,
      operation: "cancelPaymentLink",
    });
  }
}

function flag(v: boolean | undefined): string | undefined {
  return v === undefined ? undefined : String(v);
}
