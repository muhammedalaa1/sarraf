import { createHmac } from "node:crypto";
import { loadFixture } from "@sarrafjs/testing";
import { describe, expect, it } from "vitest";
import {
  kashierOrderHash,
  kashierOrderHashPath,
  kashierRedirectSignature,
  kashierRedirectSignedString,
  kashierWebhookSignature,
  kashierWebhookSignedString,
  verifyKashierRedirect,
  verifyKashierWebhookSignature,
} from "../src/index.js";

const WEBHOOKS = [
  "webhook-pay-success",
  "webhook-pay-failed",
  "webhook-special-chars",
  "webhook-refund-partial",
  // Recorded from the real Kashier sandbox (verified with the real key, then re-signed).
  "sandbox-webhook-succeeded-1",
  "sandbox-webhook-refund-partial",
  "sandbox-webhook-refund-full",
  "sandbox-webhook-refund-full-fresh",
  "sandbox-webhook-succeeded-2",
  "sandbox-webhook-void",
];

describe("kashier webhook signature", () => {
  for (const scenario of WEBHOOKS) {
    it(`matches the known-good fixture: ${scenario}`, () => {
      const f = loadFixture("kashier", scenario);
      const data = JSON.parse(f.webhook!.rawBody).data;
      expect(kashierWebhookSignedString(data)).toBe(f.signedString);
      expect(kashierWebhookSignature(data, f.secret!)).toBe(f.expectedSignature);
      expect(verifyKashierWebhookSignature(data, f.secret!, f.webhook!.headers!["x-kashier-signature"])).toBe(
        true,
      );
    });
  }

  it("encodes * ( ) ' ! strictly, which plain encodeURIComponent does not", () => {
    const f = loadFixture("kashier", "webhook-special-chars");
    expect(f.signedString).toContain("order%2A%28it%27s%29%21_");
    expect(f.signedString).toContain("&description&"); // null → bare key
    const data = JSON.parse(f.webhook!.rawBody).data;
    const naive = Object.keys(data)
      .filter((k) => data.signatureKeys.includes(k))
      .sort()
      .map((k) => `${k}=${encodeURIComponent(String(data[k]))}`)
      .join("&");
    const naiveSig = createHmac("sha256", f.secret!).update(naive).digest("hex");
    expect(verifyKashierWebhookSignature(data, f.secret!, naiveSig)).toBe(false);
  });

  it("matches real sandbox traffic, including spaces and | in signed values", () => {
    const f = loadFixture("kashier", "sandbox-webhook-succeeded-1");
    expect(f.verifiedAgainstRealSignature).toBe(true);
    expect(f.signedString).toContain("channel=online%20%7C%20e-commerce");
    expect(f.signedString).toContain("amount=10&"); // a JSON number, signed as Kashier sent it
  });

  describe("tamper cases fail", () => {
    const f = loadFixture("kashier", "webhook-pay-success");
    const data = JSON.parse(f.webhook!.rawBody).data;
    const sig = f.expectedSignature!;
    const cases: [string, Record<string, unknown>][] = [
      ["changed amount", { ...data, amount: 1 }],
      ["changed status", { ...data, status: "FAILURE" }],
      ["changed order", { ...data, merchantOrderId: "order_1" }],
      ["extra whitespace", { ...data, currency: "EGP " }],
      ["dropped signed key", { ...data, signatureKeys: data.signatureKeys.slice(1) }],
      ["no signatureKeys", { ...data, signatureKeys: undefined }],
    ];
    for (const [name, tampered] of cases) {
      it(name, () => expect(verifyKashierWebhookSignature(tampered, f.secret!, sig)).toBe(false));
    }
    it("wrong key", () => expect(verifyKashierWebhookSignature(data, "wrong", sig)).toBe(false));
    it("missing header", () => expect(verifyKashierWebhookSignature(data, f.secret!, undefined)).toBe(false));
    it("unsigned fields may change", () =>
      expect(verifyKashierWebhookSignature({ ...data, transactionResponseCode: "zz" }, f.secret!, sig)).toBe(
        true,
      ));
  });
});

describe("kashier redirect signature", () => {
  const f = loadFixture<{ query: [string, string][] }>("kashier", "redirect-success");
  const query = f.data!.query;

  it("matches the fixture and excludes signature and mode", () => {
    expect(kashierRedirectSignedString(query)).toBe(f.signedString);
    expect(kashierRedirectSignature(query, f.secret!)).toBe(f.expectedSignature);
    expect(verifyKashierRedirect(query, f.secret!)).toBe(true);
  });

  it("accepts objects and raw query strings", () => {
    expect(verifyKashierRedirect(Object.fromEntries(query), f.secret!)).toBe(true);
    const raw = `?${new URLSearchParams(query).toString()}`;
    expect(verifyKashierRedirect(raw, f.secret!)).toBe(true);
  });

  it("is order sensitive and rejects tampering", () => {
    const reordered: [string, string][] = [query[1]!, query[0]!, ...query.slice(2)];
    expect(verifyKashierRedirect(reordered, f.secret!)).toBe(false);
    const tampered = query.map(([k, v]): [string, string] => [k, k === "paymentStatus" ? "FAILURE" : v]);
    expect(verifyKashierRedirect(tampered, f.secret!)).toBe(false);
    expect(
      verifyKashierRedirect(
        query.filter(([k]) => k !== "signature"),
        f.secret!,
      ),
    ).toBe(false);
  });
});

describe("kashier redirect signature (real sandbox)", () => {
  const f = loadFixture("kashier", "sandbox-redirect-succeeded");
  const query = f.query ?? {};

  it("matches the recorded redirect: every param except signature and mode, in received order", () => {
    expect(f.verifiedAgainstRealSignature).toBe(true);
    expect(Object.keys(query).slice(-2)).toEqual(["mode", "signature"]);
    expect(kashierRedirectSignedString(query)).toBe(f.signedString);
    expect(kashierRedirectSignature(query, f.secret!)).toBe(f.expectedSignature);
    expect(verifyKashierRedirect(query, f.secret!)).toBe(true);
    expect(verifyKashierRedirect({ ...query, amount: "10.00" }, f.secret!)).toBe(false);
  });
});

describe("kashier HPP order hash", () => {
  it("matches the fixture", () => {
    const f = loadFixture<{ merchantId: string; orderId: string; amount: string; currency: string }>(
      "kashier",
      "hpp-hash",
    );
    expect(kashierOrderHashPath(f.data!)).toBe(f.signedString);
    expect(kashierOrderHash(f.data!, f.secret!)).toBe(f.expectedSignature);
  });

  it("changes with any formatting difference in amount", () => {
    const base = { merchantId: "MID-1", orderId: "o", amount: "250.00", currency: "EGP" };
    expect(kashierOrderHash(base, "k")).not.toBe(kashierOrderHash({ ...base, amount: "250" }, "k"));
    expect(kashierOrderHashPath({ ...base, customerReference: "c1" })).toBe(
      "/?payment=MID-1.o.250.00.EGP.c1",
    );
  });
});
