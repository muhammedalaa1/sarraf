import {
  type Money,
  moneySchema,
  type Payment,
  runIdempotent,
  SarrafError,
  type SavedCard,
  validateWith,
} from "@sarrafjs/core";
import { z } from "zod";
import { authedRequest, createIntention, payWithSource, toId } from "../client.js";
import { intentionBody } from "../intention.js";
import { toPaymobPayment, toSavedCard } from "../mappers.js";
import type { ExtrasDeps } from "./index.js";

const chargeSchema = z.object({
  token: z.string().min(1),
  reference: z.string().min(1).max(200),
  amount: moneySchema.refine((m) => m.value > 0, "must be greater than zero"),
  customer: z.object({
    name: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().min(6),
  }),
  webhookUrl: z.string().url().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  idempotencyKey: z.string().min(1).max(255).optional(),
});

export interface PaymobChargeInput {
  /** Card token from a `card.saved` event. */
  token: string;
  /** Merchant reference for this charge; must be unique. */
  reference: string;
  amount: Money;
  customer: { name?: string | undefined; email?: string | undefined; phone: string };
  webhookUrl?: string | undefined;
  metadata?: Record<string, string> | undefined;
  idempotencyKey?: string | undefined;
}

export class PaymobCards {
  constructor(private readonly deps: ExtrasDeps) {}

  /**
   * Merchant-initiated charge on a saved card, with no customer present: an intention on the MOTO
   * integration (`integrationIds.card_moto`) paid server side with the token. Moves money: pass an
   * `idempotencyKey` and treat `TIMEOUT_UNKNOWN_OUTCOME` as "check status before retrying".
   *
   * For a customer paying with their saved card, use `providerOptions.cardTokens` on checkout instead.
   */
  async charge(input: PaymobChargeInput): Promise<Payment> {
    const valid = validateWith(chargeSchema, input, "paymob.cards.charge");
    const { provider, config } = this.deps;
    const ctx = this.deps.ctx();
    const motoId = provider.integrationId("card_moto");
    return runIdempotent(ctx, {
      provider: "paymob",
      operation: "cards.charge",
      key: valid.idempotencyKey,
      input: { ...valid, idempotencyKey: undefined },
      ttlSeconds: 86_400,
      run: async () => {
        const body = intentionBody(
          {
            provider: "paymob",
            amount: valid.amount,
            reference: valid.reference,
            customer: valid.customer,
            webhookUrl: valid.webhookUrl,
            metadata: valid.metadata,
          },
          [motoId],
        );
        const intention = await createIntention(config, ctx, body);
        const key =
          intention.payment_keys?.find((k) => k.integration === motoId) ?? intention.payment_keys?.[0];
        if (!key) {
          throw new SarrafError(
            "PROVIDER_UNAVAILABLE",
            "paymob: the intention returned no payment key for MOTO",
            {
              provider: "paymob",
              raw: intention,
            },
          );
        }
        const txn = await payWithSource(config, ctx, key.key, { identifier: valid.token, subtype: "TOKEN" });
        const payment = toPaymobPayment(txn, config.currency);
        return { ...payment, reference: payment.reference || valid.reference };
      },
    });
  }

  /** Cards saved on a Paymob order (`order_id` of the checkout's transaction). Needs `apiKey`. */
  async listForOrder(orderId: string | number): Promise<SavedCard[]> {
    const data = await authedRequest<unknown>(this.deps.config, this.deps.ctx(), this.deps.tokens, {
      method: "POST",
      url: `${this.deps.config.baseUrl}/api/acceptance/order_card_tokens`,
      body: (token: string) => ({ auth_token: token, order_id: toId(orderId) }),
      retryable: true,
      operation: "orderCardTokens",
    });
    return cardList(data);
  }
}

/** Paymob returns card tokens as `[{type, obj}]`, `[obj]` or `{results: [...]}`. */
export function cardList(data: unknown): SavedCard[] {
  const rows = Array.isArray(data) ? data : ((data as { results?: unknown[] } | null)?.results ?? []);
  return rows
    .map((row) => {
      const r = (row ?? {}) as Record<string, unknown>;
      return toSavedCard((r.obj ?? r) as Record<string, unknown>);
    })
    .filter((c) => c.token);
}
