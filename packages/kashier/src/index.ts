import { KashierProvider } from "./adapter.js";
import type { KashierOptions } from "./config.js";

/** Create the Kashier adapter: `new Sarraf({ providers: { kashier: kashier({...}) } })`. */
export function kashier(options: KashierOptions): KashierProvider {
  return new KashierProvider(options);
}

export { KashierProvider, KASHIER_DOCS_URL, type KashierProviderOptions } from "./adapter.js";
export { KASHIER_URLS, type KashierOptions, type KashierConfig } from "./config.js";
export {
  kashierOrderHashPath,
  kashierOrderHash,
  kashierRedirectSignedString,
  kashierRedirectSignature,
  verifyKashierRedirect,
  kashierWebhookSignedString,
  kashierWebhookSignature,
  verifyKashierWebhookSignature,
  type KashierOrderHashInput,
} from "./signature.js";
export {
  KASHIER_STATUS_TABLE,
  KASHIER_METHOD_NAMES,
  mapKashierStatus,
  toKashierPayment,
  formatKashierAmount,
  type KashierTransactionData,
} from "./mappers.js";
export { KASHIER_SIGNATURE_HEADER } from "./webhooks.js";
