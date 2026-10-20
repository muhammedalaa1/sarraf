import type { RawWebhookRequest } from "@sarraf/core";
import { type FawryNotificationV2, fawryNotificationSignature } from "./signature.js";

/** A realistic V2 "PAID" notification for a PayAtFawry reference code. Override any field. */
export function fawryNotification(overrides: Partial<FawryNotificationV2> = {}): FawryNotificationV2 {
  return {
    requestId: "c72827d084ea4b88949d91dd2db4996e",
    fawryRefNumber: "970177",
    merchantRefNumber: "order_8841",
    customerMobile: "01001234567",
    customerMail: "sara@example.com",
    paymentAmount: 250.0,
    orderAmount: 250.0,
    fawryFees: 0,
    orderStatus: "PAID",
    paymentMethod: "PAYATFAWRY",
    paymentTime: 1760960000000,
    paymentRefrenceNumber: "2283311",
    orderExpiryDate: 1761046400000,
    orderItems: [{ itemCode: "order_8841", price: 250.0, quantity: 1 }],
    ...overrides,
  };
}

/** Sign a notification the way Fawry does and return it as a webhook request. */
export function signFawryNotification(n: FawryNotificationV2, secureKey: string): RawWebhookRequest {
  const messageSignature = fawryNotificationSignature(n, secureKey).signature;
  return {
    rawBody: JSON.stringify({ ...n, messageSignature }),
    headers: { "content-type": "application/json" },
  };
}
