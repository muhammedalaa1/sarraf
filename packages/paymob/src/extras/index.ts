import type { Ctx } from "@sarrafjs/core";
import type { PaymobProvider } from "../adapter.js";
import type { PaymobTokenCache } from "../client.js";
import type { PaymobConfig } from "../config.js";
import { PaymobCards } from "./cards.js";
import { PaymobIntentions } from "./intentions.js";
import { PaymobLinks } from "./links.js";
import { PaymobSubscriptions } from "./subscriptions.js";

export interface ExtrasDeps {
  provider: PaymobProvider;
  config: PaymobConfig;
  tokens: PaymobTokenCache;
  /** The `Sarraf` context, available once the adapter is registered. */
  ctx(): Ctx;
}

/** Paymob-only APIs: `pay.provider("paymob").extras`. */
export class PaymobExtras {
  /** Update or read an unpaid intention. */
  readonly intentions: PaymobIntentions;
  /** Charge saved cards (merchant-initiated) and list the cards saved on an order. */
  readonly cards: PaymobCards;
  /** Subscription plans, subscriptions, their cards and callbacks. Needs `apiKey`. */
  readonly subscriptions: PaymobSubscriptions;
  /** Payment links (QuickLinks). Needs `apiKey`. */
  readonly links: PaymobLinks;

  constructor(deps: ExtrasDeps) {
    this.intentions = new PaymobIntentions(deps);
    this.cards = new PaymobCards(deps);
    this.subscriptions = new PaymobSubscriptions(deps);
    this.links = new PaymobLinks(deps);
  }
}

export type { PaymobChargeInput } from "./cards.js";
export type { PaymobIntentionUpdate } from "./intentions.js";
export type { PaymobLinkInput, PaymobPaymentLink } from "./links.js";
export type {
  PaymobPlanInput,
  PaymobSubscription,
  PaymobSubscriptionCheckoutInput,
  PaymobSubscriptionEvent,
  PaymobSubscriptionPlan,
  PaymobSubscriptionUpdate,
} from "./subscriptions.js";
