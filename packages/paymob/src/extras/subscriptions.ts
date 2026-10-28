import {
  asRecord,
  type Checkout,
  type CreateCheckoutInput,
  type Money,
  moneySchema,
  type Payment,
  parseJsonBody,
  type RawWebhookRequest,
  SarrafError,
  type SavedCard,
  safeEqualHex,
  str,
  validateWith,
  type WebhookInspection,
} from "@sarraf/core";
import { z } from "zod";
import { authedRequest, toId } from "../client.js";
import { type PaymobTransaction, toPaymobPayment } from "../mappers.js";
import { paymobSubscriptionHmac, paymobSubscriptionSignedString } from "../signature.js";
import { cardList } from "./cards.js";
import type { ExtrasDeps } from "./index.js";

const FREQUENCIES = [7, 15, 30, 60, 90, 180, 360] as const;
const PLAN_TYPES = ["rent", "installment", "purchase", "bundle", "merchant_subscription", "other"] as const;

const planSchema = z.object({
  name: z.string().min(1),
  /** Days between charges. */
  frequency: z
    .number()
    .int()
    .refine(
      (f) => (FREQUENCIES as readonly number[]).includes(f),
      `must be one of ${FREQUENCIES.join(", ")}`,
    ),
  amount: moneySchema.refine((m) => m.value > 0, "must be greater than zero"),
  /** MOTO integration for renewals. Defaults to `integrationIds.card_moto`. */
  integrationId: z.number().int().positive().optional(),
  reminderDays: z.number().int().nonnegative().optional(),
  retrialDays: z.number().int().nonnegative().optional(),
  planType: z.enum(PLAN_TYPES).optional(),
  /** Number of charges. `null` = until canceled. */
  numberOfDeductions: z.number().int().positive().nullable().optional(),
  /** Charge the first transaction's amount instead of `amount`. */
  useTransactionAmount: z.boolean().optional(),
  isActive: z.boolean().optional(),
  webhookUrl: z.string().url().optional(),
});

export type PaymobPlanInput = z.input<typeof planSchema>;

type PlanFields = { [K in keyof z.output<typeof planSchema>]?: z.output<typeof planSchema>[K] | undefined };

/** A plan as Paymob returns it. */
export interface PaymobSubscriptionPlan {
  id: number;
  name?: string;
  frequency?: number;
  amount_cents?: number;
  is_active?: boolean;
  integration?: number;
  [k: string]: unknown;
}

/** A subscription as Paymob returns it. */
export interface PaymobSubscription {
  id: number;
  plan_id?: number;
  state?: string;
  amount_cents?: number;
  starts_at?: string;
  next_billing?: string;
  ends_at?: string | null;
  [k: string]: unknown;
}

export interface PaymobSubscriptionUpdate {
  amount?: Money | undefined;
  /** `YYYY-MM-DD` */
  endsAt?: string | undefined;
  /** `YYYY-MM-DD` */
  nextBilling?: string | undefined;
}

/** Checkout for the first (3DS) payment of a subscription. */
export type PaymobSubscriptionCheckoutInput = Omit<CreateCheckoutInput<"paymob">, "provider" | "methods"> & {
  planId: number;
  /** `YYYY-MM-DD`. Omit to start now. */
  startDate?: string | undefined;
};

/** Paymob's subscription trigger types, e.g. `"Successful Transaction"`, `"suspended"`. */
export interface PaymobSubscriptionEvent {
  /** Dedupe key: `"paymob:subscription:<id>:<trigger>:<request id>"`. */
  id: string;
  trigger: string;
  subscriptionId: number;
  subscription: PaymobSubscription;
  receivedAt: string;
  raw: unknown;
}

const SUBSCRIPTION_ALGORITHM = 'HMAC-SHA512(hex) over "<trigger_type>for<subscription_data.id>"';

export class PaymobSubscriptions {
  /** Subscription plans: the amount, frequency and MOTO integration renewals use. */
  readonly plans = {
    create: async (input: PaymobPlanInput): Promise<PaymobSubscriptionPlan> => {
      const p = validateWith(planSchema, input, "paymob.subscriptions.plans.create");
      return this.call("POST", "/subscription-plans", "createPlan", this.planBody(p, true));
    },
    list: async (): Promise<PaymobSubscriptionPlan[]> =>
      rows(await this.call<unknown>("GET", "/subscription-plans", "listPlans")) as PaymobSubscriptionPlan[],
    update: async (planId: number, input: Partial<PaymobPlanInput>): Promise<PaymobSubscriptionPlan> => {
      const p = validateWith(planSchema.partial(), input, "paymob.subscriptions.plans.update");
      return this.call("PUT", `/subscription-plans/${toId(planId)}`, "updatePlan", this.planBody(p, false));
    },
    suspend: async (planId: number): Promise<PaymobSubscriptionPlan> =>
      this.call("POST", `/subscription-plans/${toId(planId)}/suspend`, "suspendPlan"),
    resume: async (planId: number): Promise<PaymobSubscriptionPlan> =>
      this.call("POST", `/subscription-plans/${toId(planId)}/resume`, "resumePlan"),
  };

  /** Cards on a subscription. Renewals charge the primary card. */
  readonly cards = {
    list: async (subscriptionId: number): Promise<SavedCard[]> =>
      cardList(
        await this.call<unknown>(
          "GET",
          `/subscriptions/${toId(subscriptionId)}/card-tokens`,
          "subscriptionCards",
        ),
      ),
    /** Checkout where the customer adds a secondary card (3DS) to the subscription. */
    add: async (
      subscriptionId: number,
      input: Omit<CreateCheckoutInput<"paymob">, "provider" | "methods">,
    ): Promise<Checkout> =>
      this.deps.provider.createCheckout(
        {
          ...input,
          provider: "paymob",
          methods: ["card"],
          providerOptions: { ...input.providerOptions, addCardToSubscription: toId(subscriptionId) },
        },
        this.deps.ctx(),
      ),
    remove: async (subscriptionId: number, cardId: number): Promise<PaymobSubscription> =>
      this.call("POST", `/subscriptions/${toId(subscriptionId)}/delete-card`, "deleteCard", {
        card: toId(cardId),
      }),
    setPrimary: async (subscriptionId: number, cardId: number): Promise<PaymobSubscription> =>
      this.call("POST", `/subscriptions/${toId(subscriptionId)}/change-primary-card`, "changePrimaryCard", {
        card: toId(cardId),
      }),
  };

  constructor(private readonly deps: ExtrasDeps) {}

  /**
   * Checkout for the first payment (card, 3DS). Paymob creates the subscription when it succeeds and
   * charges the plan's MOTO integration after that.
   */
  async create(input: PaymobSubscriptionCheckoutInput): Promise<Checkout> {
    const { planId, startDate, ...checkout } = input;
    return this.deps.provider.createCheckout(
      {
        ...checkout,
        provider: "paymob",
        methods: ["card"],
        providerOptions: { ...checkout.providerOptions, subscription: { planId: toId(planId), startDate } },
      },
      this.deps.ctx(),
    );
  }

  async get(subscriptionId: number): Promise<PaymobSubscription> {
    return this.call("GET", `/subscriptions/${toId(subscriptionId)}`, "getSubscription");
  }

  /** Filters are passed to Paymob as is, e.g. `{ plan_id: 12, state: "active" }`. */
  async list(filters: Record<string, string | number | undefined> = {}): Promise<PaymobSubscription[]> {
    return rows(
      await this.call<unknown>("GET", "/subscriptions", "listSubscriptions", undefined, filters),
    ) as PaymobSubscription[];
  }

  async update(subscriptionId: number, input: PaymobSubscriptionUpdate): Promise<PaymobSubscription> {
    return this.call("PUT", `/subscriptions/${toId(subscriptionId)}`, "updateSubscription", {
      amount_cents: input.amount?.value,
      ends_at: input.endsAt,
      next_billing: input.nextBilling,
    });
  }

  async suspend(subscriptionId: number): Promise<PaymobSubscription> {
    return this.call("POST", `/subscriptions/${toId(subscriptionId)}/suspend`, "suspendSubscription");
  }

  async resume(subscriptionId: number): Promise<PaymobSubscription> {
    return this.call("POST", `/subscriptions/${toId(subscriptionId)}/resume`, "resumeSubscription");
  }

  async cancel(subscriptionId: number): Promise<PaymobSubscription> {
    return this.call("POST", `/subscriptions/${toId(subscriptionId)}/cancel`, "cancelSubscription");
  }

  async lastTransaction(subscriptionId: number): Promise<Payment> {
    const txn = await this.call<PaymobTransaction>(
      "GET",
      `/subscriptions/${toId(subscriptionId)}/last-transaction`,
      "lastSubscriptionTransaction",
    );
    return toPaymobPayment(txn, this.deps.config.currency);
  }

  async transactions(subscriptionId: number): Promise<Payment[]> {
    const data = await this.call<unknown>(
      "GET",
      `/subscriptions/${toId(subscriptionId)}/transactions`,
      "subscriptionTransactions",
    );
    return (rows(data) as PaymobTransaction[]).map((t) => toPaymobPayment(t, this.deps.config.currency));
  }

  /** Point this subscription's callbacks at `url`. */
  async registerWebhook(subscriptionId: number, url: string): Promise<unknown> {
    return this.call(
      "POST",
      `/subscriptions/${toId(subscriptionId)}/register_webhook`,
      "registerSubscriptionWebhook",
      { url },
    );
  }

  /** Signature diagnostics for a subscription callback, without throwing. */
  inspectWebhook(req: RawWebhookRequest): WebhookInspection {
    let body: Record<string, unknown>;
    try {
      body = asRecord(parseJsonBody("paymob", req.rawBody));
    } catch {
      return { valid: false, algorithm: SUBSCRIPTION_ALGORITHM, reason: "body is not valid JSON" };
    }
    const received = str(body.hmac);
    if (!asRecord(body.subscription_data).id || !body.trigger_type) {
      return {
        valid: false,
        algorithm: SUBSCRIPTION_ALGORITHM,
        received,
        reason: "not a subscription callback",
      };
    }
    const expected = paymobSubscriptionHmac(body, this.deps.config.hmacSecret);
    return {
      valid: safeEqualHex(expected, received),
      signedString: paymobSubscriptionSignedString(body),
      expected,
      received,
      algorithm: SUBSCRIPTION_ALGORITHM,
      reason: received ? undefined : "missing `hmac` in the body",
    };
  }

  /** Verify and normalize a subscription callback. Throws `WEBHOOK_SIGNATURE_INVALID`. */
  verifyWebhook(req: RawWebhookRequest): PaymobSubscriptionEvent {
    const inspection = this.inspectWebhook(req);
    if (!inspection.valid) {
      throw new SarrafError(
        "WEBHOOK_SIGNATURE_INVALID",
        `paymob subscription callback rejected: ${inspection.reason ?? "HMAC mismatch (check hmacSecret)"}`,
        { provider: "paymob" },
      );
    }
    const body = asRecord(parseJsonBody("paymob", req.rawBody));
    const subscription = asRecord(body.subscription_data) as PaymobSubscription;
    const trigger = str(body.trigger_type) ?? "";
    return {
      id: `paymob:subscription:${subscription.id}:${trigger}:${str(body.paymob_request_id) ?? ""}`,
      trigger,
      subscriptionId: Number(subscription.id),
      subscription,
      receivedAt: this.deps.ctx().now().toISOString(),
      raw: body,
    };
  }

  private planBody(p: PlanFields, creating: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      name: p.name,
      frequency: p.frequency,
      amount_cents: p.amount?.value,
      reminder_days: p.reminderDays,
      retrial_days: p.retrialDays,
      plan_type: p.planType,
      number_of_deductions: p.numberOfDeductions,
      use_transaction_amount: p.useTransactionAmount,
      is_active: p.isActive,
      webhook_url: p.webhookUrl,
      integration: p.integrationId,
    };
    // A new plan needs a MOTO integration for renewals; default to the configured one.
    if (creating && body.integration === undefined) {
      body.integration = this.deps.provider.integrationId("card_moto");
      body.is_active ??= true;
    }
    return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
  }

  private async call<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    operation: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    return authedRequest<T>(this.deps.config, this.deps.ctx(), this.deps.tokens, {
      method,
      url: `${this.deps.config.baseUrl}/api/acceptance${path}`,
      body,
      query,
      operation,
    });
  }
}

/** List endpoints answer with an array or a paginated `{ results: [...] }`. */
function rows(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const results = asRecord(data).results;
  return Array.isArray(results) ? results : [];
}
