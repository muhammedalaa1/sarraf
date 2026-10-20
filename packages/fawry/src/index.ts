import { FawryProvider } from "./adapter.js";
import type { FawryOptions } from "./config.js";

/** Create the Fawry adapter: `new Sarraf({ providers: { fawry: fawry({...}) } })`. */
export function fawry(options: FawryOptions): FawryProvider {
  return new FawryProvider(options);
}

export { FawryProvider, FAWRY_DOCS_URL, type FawryProviderOptions } from "./adapter.js";
export { FAWRY_BASE_URLS, type FawryOptions, type FawryConfig } from "./config.js";
export {
  fawryChargeSignature,
  fawryStatusSignature,
  fawryRefundSignature,
  fawryCancelSignature,
  fawryExpressCheckoutSignature,
  fawryNotificationSignature,
  verifyFawryNotification,
  type FawryNotificationV2,
  type SignedParts,
} from "./signature.js";
export {
  FAWRY_STATUS_TABLE,
  FAWRY_METHODS,
  mapFawryStatus,
  mapFawryMethod,
  toFawryPayment,
  toFawryMobile,
} from "./mappers.js";
