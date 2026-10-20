import { KashierProvider } from "./adapter.js";
import type { KashierOptions } from "./config.js";

/** Create the Kashier adapter: `new Sarraf({ providers: { kashier: kashier({...}) } })`. */
export function kashier(options: KashierOptions): KashierProvider {
  return new KashierProvider(options);
}

export { KASHIER_DOCS_URL, KashierProvider, type KashierProviderOptions } from "./adapter.js";
export { KASHIER_URLS, type KashierConfig, type KashierOptions } from "./config.js";
export {
  formatKashierAmount,
  KASHIER_METHOD_NAMES,
  KASHIER_STATUS_TABLE,
  type KashierTransactionData,
  mapKashierStatus,
  toKashierPayment,
} from "./mappers.js";
export {
  type KashierOrderHashInput,
  kashierOrderHash,
  kashierOrderHashPath,
  kashierRedirectSignature,
  kashierRedirectSignedString,
  kashierWebhookSignature,
  kashierWebhookSignedString,
  verifyKashierRedirect,
  verifyKashierWebhookSignature,
} from "./signature.js";
export { KASHIER_SIGNATURE_HEADER } from "./webhooks.js";
