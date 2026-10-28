import { type Checkout, SarrafError } from "@sarraf/core";
import {
  type PaymobIntentionRequest,
  type PaymobIntentionResponse,
  retrieveIntention,
  updateIntention,
} from "../client.js";
import type { ExtrasDeps } from "./index.js";

/** Paymob intention fields to change, in Paymob's own shape (`amount` in cents, `items`, `billing_data`, …). */
export type PaymobIntentionUpdate = Partial<PaymobIntentionRequest>;

export class PaymobIntentions {
  constructor(private readonly deps: ExtrasDeps) {}

  /**
   * Change an unpaid intention (amount, items, billing data, methods, URLs). Paymob needs the
   * intention's order id, which the checkout carries in `raw.intention_order_id`.
   */
  async update(checkout: Checkout, patch: PaymobIntentionUpdate): Promise<PaymobIntentionResponse> {
    const { clientSecret, orderId } = intentionOf(checkout);
    return updateIntention(this.deps.config, this.deps.ctx(), clientSecret, {
      ...patch,
      accept_order_id: orderId,
    });
  }

  /** Read an intention back (status, amount, payment methods). Uses the public key only. */
  async retrieve(checkout: Checkout): Promise<PaymobIntentionResponse> {
    return retrieveIntention(this.deps.config, this.deps.ctx(), intentionOf(checkout).clientSecret);
  }
}

function intentionOf(checkout: Checkout): { clientSecret: string; orderId: number } {
  const raw = (checkout.raw ?? {}) as Partial<PaymobIntentionResponse> & {
    intention?: PaymobIntentionResponse;
  };
  const intention = raw.intention ?? raw;
  const clientSecret = intention.client_secret;
  const orderId = Number(intention.intention_order_id);
  if (checkout.provider !== "paymob" || !clientSecret || !Number.isSafeInteger(orderId)) {
    throw new SarrafError("INVALID_REQUEST", "expected a Paymob checkout returned by checkout.create", {
      provider: "paymob",
    });
  }
  return { clientSecret, orderId };
}
