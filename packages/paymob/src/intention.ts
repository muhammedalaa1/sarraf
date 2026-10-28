import type { CreateCheckoutInput } from "@sarraf/core";
import type { PaymobIntentionRequest } from "./client.js";

/** Sarraf checkout input → Paymob intention body. Shared by checkout, saved-card charges and subscriptions. */
export function intentionBody(
  input: CreateCheckoutInput<"paymob">,
  paymentMethods: (number | string)[],
): PaymobIntentionRequest {
  const opts = input.providerOptions ?? {};
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
    // sarraf_ref last: it is how webhooks find the order when merchant_order_id is missing.
    extras: { ...input.metadata, ...opts.extras, sarraf_ref: input.reference },
  };
  if (opts.cardTokens?.length) body.card_tokens = opts.cardTokens;
  if (opts.subscription) {
    body.subscription_plan_id = opts.subscription.planId;
    if (opts.subscription.startDate) body.subscription_start_date = opts.subscription.startDate;
  }
  if (opts.addCardToSubscription !== undefined) body.subscriptionv2_id = opts.addCardToSubscription;
  return body;
}
