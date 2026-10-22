import { loadFixture } from "@sarrafjs/testing";
import { describe, expect, it } from "vitest";
import {
  PAYMOB_REDIRECT_HMAC_FIELDS,
  PAYMOB_TRANSACTION_HMAC_FIELDS,
  paymobRedirectSignedString,
  paymobSignedString,
  paymobTransactionHmac,
  verifyPaymobTransactionHmac,
} from "../src/index.js";

const SCENARIOS = [
  "callback-succeeded",
  "callback-declined",
  "callback-partially-refunded",
  "callback-null-fields",
];

describe("paymob transaction HMAC", () => {
  for (const scenario of SCENARIOS) {
    it(`matches the known-good fixture: ${scenario}`, () => {
      const f = loadFixture("paymob", scenario);
      const obj = JSON.parse(f.webhook!.rawBody).obj;
      expect(paymobSignedString(obj)).toBe(f.signedString);
      expect(paymobTransactionHmac(obj, f.secret!)).toBe(f.expectedSignature);
      expect(verifyPaymobTransactionHmac(obj, f.secret!, f.expectedSignature)).toBe(true);
    });
  }

  describe("tamper cases fail", () => {
    const f = loadFixture("paymob", "callback-succeeded");
    const obj = JSON.parse(f.webhook!.rawBody).obj;
    const sig = f.expectedSignature!;
    const cases: [string, Record<string, unknown>][] = [
      ["changed amount", { ...obj, amount_cents: 1 }],
      ["changed status", { ...obj, success: false }],
      ["changed order id", { ...obj, order: { ...obj.order, id: 1 } }],
      ["changed pan", { ...obj, source_data: { ...obj.source_data, pan: "0000" } }],
      ["extra whitespace", { ...obj, currency: "EGP " }],
      ["string vs boolean formatting", { ...obj, success: "True" }],
    ];
    for (const [name, tampered] of cases) {
      it(name, () => expect(verifyPaymobTransactionHmac(tampered, f.secret!, sig)).toBe(false));
    }
    it("wrong key", () => expect(verifyPaymobTransactionHmac(obj, "wrong", sig)).toBe(false));
    it("missing signature", () => expect(verifyPaymobTransactionHmac(obj, f.secret!, undefined)).toBe(false));
  });

  it("covers exactly 20 fields in Paymob's order, with Paymob's spelling", () => {
    expect(PAYMOB_TRANSACTION_HMAC_FIELDS).toHaveLength(20);
    expect(PAYMOB_TRANSACTION_HMAC_FIELDS).toContain("error_occured");
    expect(PAYMOB_TRANSACTION_HMAC_FIELDS[0]).toBe("amount_cents");
    expect(PAYMOB_TRANSACTION_HMAC_FIELDS[19]).toBe("success");
    expect(PAYMOB_REDIRECT_HMAC_FIELDS[13]).toBe("order");
  });

  it("builds the redirect signed string from flattened params", () => {
    const q = Object.fromEntries(PAYMOB_REDIRECT_HMAC_FIELDS.map((k, i) => [k, String(i)]));
    expect(paymobRedirectSignedString(q)).toBe(PAYMOB_REDIRECT_HMAC_FIELDS.map((_, i) => i).join(""));
    expect(paymobRedirectSignedString({})).toBe("");
  });
});
