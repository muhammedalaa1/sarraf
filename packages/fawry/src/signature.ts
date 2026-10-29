import { normalizeDecimal, safeEqualHex, sha256Hex } from "@sarrafjs/core";

/**
 * Fawry signatures are plain SHA-256 (hex) of a concatenated string ending with the secure key.
 * Every endpoint uses a different field order, so each has its own function. Amounts are always
 * written with exactly two decimals ("250.00"), never "250".
 */

const amount2dp = (v: string | number) => normalizeDecimal(v, 2);

/** Strings below never include the secure key, so they are safe to log and show in the dashboard. */
export interface SignedParts {
  /** Concatenated fields without the secure key. */
  signedString: string;
  signature: string;
}

function sign(parts: (string | number | undefined | null)[], secureKey: string): SignedParts {
  const signedString = parts.map((p) => (p === undefined || p === null ? "" : String(p))).join("");
  return { signedString, signature: sha256Hex(signedString + secureKey) };
}

export interface FawryChargeSignatureInput {
  merchantCode: string;
  merchantRefNum: string;
  customerProfileId?: string | undefined;
  paymentMethod: string;
  amount: string | number;
}

/** Charge: merchantCode + merchantRefNum + customerProfileId + paymentMethod + amount(2dp) + secureKey. ✅ */
export function fawryChargeSignature(input: FawryChargeSignatureInput, secureKey: string): SignedParts {
  return sign(
    [
      input.merchantCode,
      input.merchantRefNum,
      input.customerProfileId,
      input.paymentMethod,
      amount2dp(input.amount),
    ],
    secureKey,
  );
}

/** Status v2: merchantCode + merchantRefNumber + secureKey. ✅ */
export function fawryStatusSignature(
  merchantCode: string,
  merchantRefNumber: string,
  secureKey: string,
): SignedParts {
  return sign([merchantCode, merchantRefNumber], secureKey);
}

/** Refund: merchantCode + referenceNumber + refundAmount(2dp) + reason + secureKey. ⚠️ */
export function fawryRefundSignature(
  input: {
    merchantCode: string;
    referenceNumber: string;
    refundAmount: string | number;
    reason?: string | undefined;
  },
  secureKey: string,
): SignedParts {
  return sign(
    [input.merchantCode, input.referenceNumber, amount2dp(input.refundAmount), input.reason],
    secureKey,
  );
}

/** Cancel unpaid order: merchantAccount + orderRefNo + lang + secureKey. ⚠️ */
export function fawryCancelSignature(
  input: { merchantAccount: string; orderRefNo: string; lang: string },
  secureKey: string,
): SignedParts {
  return sign([input.merchantAccount, input.orderRefNo, input.lang], secureKey);
}

export interface FawryExpressItem {
  itemId: string;
  quantity: number;
  price: string | number;
}

/**
 * Hosted (Express) checkout init: merchantCode + merchantRefNum + customerProfileId + returnUrl
 * + for each item sorted by itemId: itemId + quantity + price(2dp) + secureKey. ⚠️
 */
export function fawryExpressCheckoutSignature(
  input: {
    merchantCode: string;
    merchantRefNum: string;
    customerProfileId?: string | undefined;
    returnUrl: string;
    items: FawryExpressItem[];
  },
  secureKey: string,
): SignedParts {
  const items = [...input.items]
    .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0))
    .flatMap((i) => [i.itemId, i.quantity, amount2dp(i.price)]);
  return sign(
    [input.merchantCode, input.merchantRefNum, input.customerProfileId, input.returnUrl, ...items],
    secureKey,
  );
}

export interface FawryNotificationV2 {
  requestId?: string | undefined;
  fawryRefNumber?: string | number | undefined;
  merchantRefNumber?: string | undefined;
  merchantRefNum?: string | undefined;
  customerMobile?: string | undefined;
  customerMail?: string | undefined;
  paymentAmount?: number | string | undefined;
  orderAmount?: number | string | undefined;
  fawryFees?: number | string | undefined;
  orderStatus?: string | undefined;
  paymentMethod?: string | undefined;
  paymentTime?: number | string | undefined;
  /** Fawry's spelling. */
  paymentRefrenceNumber?: string | number | undefined;
  orderExpiryDate?: number | string | undefined;
  orderItems?: unknown[] | undefined;
  messageSignature?: string | undefined;
  [k: string]: unknown;
}

/**
 * V2 server notification messageSignature. ⚠️ Verify with a real sandbox notification:
 * fawryRefNumber + merchantRefNumber + paymentAmount(2dp) + orderAmount(2dp) + orderStatus
 * + paymentMethod + paymentRefrenceNumber("" if missing) + secureKey.
 */
export function fawryNotificationSignature(n: FawryNotificationV2, secureKey: string): SignedParts {
  return sign(
    [
      n.fawryRefNumber,
      n.merchantRefNumber ?? n.merchantRefNum,
      amount2dp(n.paymentAmount ?? 0),
      amount2dp(n.orderAmount ?? 0),
      n.orderStatus,
      n.paymentMethod,
      n.paymentRefrenceNumber,
    ],
    secureKey,
  );
}

export function verifyFawryNotification(n: FawryNotificationV2, secureKey: string): boolean {
  try {
    return safeEqualHex(fawryNotificationSignature(n, secureKey).signature, n.messageSignature);
  } catch {
    return false;
  }
}
