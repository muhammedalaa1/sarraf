import { PaymobProvider } from "./adapter.js";
import type { PaymobOptions } from "./config.js";

/** Create the Paymob adapter: `new Sarraf({ providers: { paymob: paymob({...}) } })`. */
export function paymob(options: PaymobOptions): PaymobProvider {
  return new PaymobProvider(options);
}

export { PAYMOB_DOCS_URL, PaymobProvider, type PaymobProviderOptions, paymobEmbed } from "./adapter.js";
export type { PaymobIntentionResponse, PaymobPaymentKey } from "./client.js";
export {
  PAYMOB_INTEGRATION_ENV,
  PAYMOB_REGIONS,
  type PaymobConfig,
  type PaymobIntegration,
  type PaymobOptions,
  type PaymobRegion,
  paymobIntegrationIdsFromEnv,
} from "./config.js";
export {
  type PaymobChargeInput,
  PaymobExtras,
  type PaymobIntentionUpdate,
  type PaymobLinkInput,
  type PaymobPaymentLink,
  type PaymobPlanInput,
  type PaymobSubscription,
  type PaymobSubscriptionCheckoutInput,
  type PaymobSubscriptionEvent,
  type PaymobSubscriptionPlan,
  type PaymobSubscriptionUpdate,
} from "./extras/index.js";
export {
  mapPaymobStatus,
  PAYMOB_STATUS_TABLE,
  type PaymobTransaction,
  toPaymobPayment,
  toSavedCard,
} from "./mappers.js";
export {
  PAYMOB_REDIRECT_HMAC_FIELDS,
  PAYMOB_TOKEN_HMAC_FIELDS,
  PAYMOB_TRANSACTION_HMAC_FIELDS,
  paymobRedirectHmac,
  paymobRedirectSignedString,
  paymobSignedString,
  paymobSubscriptionHmac,
  paymobSubscriptionSignedString,
  paymobTokenHmac,
  paymobTokenSignedString,
  paymobTransactionHmac,
  verifyPaymobTransactionHmac,
} from "./signature.js";
