import { loadFixture } from "@sarrafjs/testing";
import { describe, expect, it } from "vitest";
import {
  fawryCancelSignature,
  fawryChargeSignature,
  fawryExpressCheckoutSignature,
  fawryNotificationSignature,
  fawryRefundSignature,
  fawryStatusSignature,
  verifyFawryNotification,
} from "../src/index.js";

// biome-ignore lint/suspicious/noExplicitAny: fixture data is loosely typed
type Any = any;

describe("fawry request signatures (one function per endpoint)", () => {
  const cases: [string, (d: Any, k: string) => { signedString: string; signature: string }][] = [
    ["signature-charge", (d, k) => fawryChargeSignature(d, k)],
    ["signature-charge-profile", (d, k) => fawryChargeSignature(d, k)],
    ["signature-status", (d, k) => fawryStatusSignature(d.merchantCode, d.merchantRefNumber, k)],
    ["signature-refund", (d, k) => fawryRefundSignature(d, k)],
    ["signature-cancel", (d, k) => fawryCancelSignature(d, k)],
    ["signature-express", (d, k) => fawryExpressCheckoutSignature(d, k)],
  ];
  for (const [scenario, fn] of cases) {
    it(`matches the known-good fixture: ${scenario}`, () => {
      const f = loadFixture<Any>("fawry", scenario);
      const out = fn(f.data, f.secret!);
      expect(out.signedString).toBe(f.signedString);
      expect(out.signature).toBe(f.expectedSignature);
      expect(out.signedString).not.toContain(f.secret!);
    });
  }

  it("always writes two decimals: 250 and 250.00 sign the same", () => {
    const base = { merchantCode: "M", merchantRefNum: "r", paymentMethod: "PAYATFAWRY" };
    expect(fawryChargeSignature({ ...base, amount: 250 }, "k")).toEqual(
      fawryChargeSignature({ ...base, amount: "250.00" }, "k"),
    );
    expect(fawryChargeSignature({ ...base, amount: "250.5" }, "k").signedString).toContain("250.50");
    expect(() => fawryChargeSignature({ ...base, amount: "250.555" }, "k")).toThrow();
  });

  it("field order differs per endpoint", () => {
    const charge = fawryChargeSignature(
      { merchantCode: "M", merchantRefNum: "R", paymentMethod: "P", amount: 1 },
      "k",
    );
    const status = fawryStatusSignature("M", "R", "k");
    expect(charge.signature).not.toBe(status.signature);
  });
});

describe("fawry V2 notification signature", () => {
  for (const scenario of ["notification-paid", "notification-expired", "notification-card-paid"]) {
    it(`matches the known-good fixture: ${scenario}`, () => {
      const f = loadFixture("fawry", scenario);
      const n = JSON.parse(f.webhook!.rawBody);
      expect(fawryNotificationSignature(n, f.secret!).signedString).toBe(f.signedString);
      expect(verifyFawryNotification(n, f.secret!)).toBe(true);
    });
  }

  it("re-formats amounts that JSON.parse turned into 250", () => {
    const f = loadFixture("fawry", "notification-paid");
    expect(f.webhook!.rawBody).toContain('"paymentAmount":250,');
    expect(f.signedString).toContain("250.00250.00");
  });

  it("accepts the merchantRefNum spelling", () => {
    const f = loadFixture("fawry", "notification-paid");
    const { merchantRefNumber, ...n } = JSON.parse(f.webhook!.rawBody);
    expect(verifyFawryNotification({ ...n, merchantRefNum: merchantRefNumber }, f.secret!)).toBe(true);
  });

  describe("tamper cases fail", () => {
    const f = loadFixture("fawry", "notification-paid");
    const n = JSON.parse(f.webhook!.rawBody);
    const cases: [string, Record<string, unknown>][] = [
      ["changed amount", { ...n, paymentAmount: 1 }],
      ["changed order amount", { ...n, orderAmount: 2500 }],
      ["changed status", { ...n, orderStatus: "EXPIRED" }],
      ["changed reference", { ...n, merchantRefNumber: "order_1" }],
      ["changed method", { ...n, paymentMethod: "CARD" }],
      ["extra whitespace", { ...n, orderStatus: "PAID " }],
      ["garbage amount", { ...n, paymentAmount: "abc" }],
    ];
    for (const [name, tampered] of cases) {
      it(name, () => expect(verifyFawryNotification(tampered, f.secret!)).toBe(false));
    }
    it("wrong key", () => expect(verifyFawryNotification(n, "wrong")).toBe(false));
    it("missing signature", () =>
      expect(verifyFawryNotification({ ...n, messageSignature: undefined }, f.secret!)).toBe(false));
  });
});
