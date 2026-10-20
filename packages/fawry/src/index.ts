import { FawryProvider } from "./adapter.js";
import type { FawryOptions } from "./config.js";

/** Create the Fawry adapter: `new Sarraf({ providers: { fawry: fawry({...}) } })`. */
export function fawry(options: FawryOptions): FawryProvider {
  return new FawryProvider(options);
}

export { FAWRY_DOCS_URL, FawryProvider, type FawryProviderOptions } from "./adapter.js";
export { FAWRY_BASE_URLS, type FawryConfig, type FawryOptions } from "./config.js";
export {
  FAWRY_METHODS,
  FAWRY_STATUS_TABLE,
  mapFawryMethod,
  mapFawryStatus,
  toFawryMobile,
  toFawryPayment,
} from "./mappers.js";
export {
  type FawryNotificationV2,
  fawryCancelSignature,
  fawryChargeSignature,
  fawryExpressCheckoutSignature,
  fawryNotificationSignature,
  fawryRefundSignature,
  fawryStatusSignature,
  type SignedParts,
  verifyFawryNotification,
} from "./signature.js";
