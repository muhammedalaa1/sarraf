import type { RawWebhookRequest } from "@sarraf/core";
import type { KashierTransactionData } from "./mappers.js";
import { kashierRedirectSignature, kashierWebhookSignature } from "./signature.js";
import { KASHIER_SIGNATURE_HEADER } from "./webhooks.js";

/** A realistic successful card payment webhook `data`, for tests. Override any field. */
export function kashierWebhookData(overrides: Partial<KashierTransactionData> = {}): KashierTransactionData {
  return {
    merchantOrderId: "order_8841",
    kashierOrderId: "ko_6527a1b2c3",
    orderReference: "TEST-ORD-18213",
    transactionId: "TX-2491820431",
    status: "SUCCESS",
    method: "card",
    creationDate: "2026-10-20T13:37:02.118Z",
    amount: 250,
    currency: "EGP",
    card: { cardInfo: { cardBrand: "Visa", maskedCard: "411111******1111" } },
    transactionResponseCode: "00",
    transactionResponseMessage: { en: "Approved", ar: "تمت الموافقة" },
    signatureKeys: [
      "merchantOrderId",
      "kashierOrderId",
      "orderReference",
      "transactionId",
      "status",
      "method",
      "creationDate",
      "amount",
      "currency",
    ],
    ...overrides,
  };
}

/** Build a signed webhook request, as Kashier would POST it. */
export function signKashierWebhook(
  event: string,
  data: KashierTransactionData,
  apiKey: string,
): RawWebhookRequest {
  return {
    rawBody: JSON.stringify({ event, data }),
    headers: {
      "content-type": "application/json",
      [KASHIER_SIGNATURE_HEADER]: kashierWebhookSignature(data, apiKey),
    },
  };
}

/** Build signed redirect query params (signature appended last, mode kept). */
export function signKashierRedirect(query: Record<string, string>, apiKey: string): Record<string, string> {
  return { ...query, signature: kashierRedirectSignature(query, apiKey) };
}
