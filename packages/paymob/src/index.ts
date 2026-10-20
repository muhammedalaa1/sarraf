import { PaymobProvider } from "./adapter.js";
import type { PaymobOptions } from "./config.js";

/** Create the Paymob adapter: `new Sarraf({ providers: { paymob: paymob({...}) } })`. */
export function paymob(options: PaymobOptions): PaymobProvider {
  return new PaymobProvider(options);
}

export { PaymobProvider, PAYMOB_DOCS_URL, type PaymobProviderOptions } from "./adapter.js";
export { PAYMOB_REGIONS, type PaymobOptions, type PaymobRegion, type PaymobConfig } from "./config.js";
export {
  PAYMOB_TRANSACTION_HMAC_FIELDS,
  PAYMOB_REDIRECT_HMAC_FIELDS,
  paymobSignedString,
  paymobTransactionHmac,
  verifyPaymobTransactionHmac,
  paymobRedirectSignedString,
  paymobRedirectHmac,
} from "./signature.js";
export { PAYMOB_STATUS_TABLE, mapPaymobStatus, toPaymobPayment, type PaymobTransaction } from "./mappers.js";
