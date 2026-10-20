import { PaymobProvider } from "./adapter.js";
import type { PaymobOptions } from "./config.js";

/** Create the Paymob adapter: `new Sarraf({ providers: { paymob: paymob({...}) } })`. */
export function paymob(options: PaymobOptions): PaymobProvider {
  return new PaymobProvider(options);
}

export { PAYMOB_DOCS_URL, PaymobProvider, type PaymobProviderOptions } from "./adapter.js";
export { PAYMOB_REGIONS, type PaymobConfig, type PaymobOptions, type PaymobRegion } from "./config.js";
export { mapPaymobStatus, PAYMOB_STATUS_TABLE, type PaymobTransaction, toPaymobPayment } from "./mappers.js";
export {
  PAYMOB_REDIRECT_HMAC_FIELDS,
  PAYMOB_TRANSACTION_HMAC_FIELDS,
  paymobRedirectHmac,
  paymobRedirectSignedString,
  paymobSignedString,
  paymobTransactionHmac,
  verifyPaymobTransactionHmac,
} from "./signature.js";
