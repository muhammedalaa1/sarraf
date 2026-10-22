import { Sarraf, silentLogger } from "@sarrafjs/core";
import { fawry } from "@sarrafjs/fawry";
import { fawryNotification, signFawryNotification } from "@sarrafjs/fawry/testing";
import { kashier } from "@sarrafjs/kashier";
import { kashierWebhookData, signKashierRedirect, signKashierWebhook } from "@sarrafjs/kashier/testing";
import { paymob } from "@sarrafjs/paymob";
import { paymobTransaction, signPaymobCallback } from "@sarrafjs/paymob/testing";
import { describe, expect, it } from "vitest";
import { isPlaceholder } from "./env.js";
import { resign, resignRedirect, TEST_SECRETS } from "./record-fixtures.js";
import { scrub, scrubUrl } from "./scrub.js";

describe("scrub", () => {
  it("replaces secrets and PII but keeps structure", () => {
    const out = scrub({
      token: "abc",
      client_secret: "cs",
      hmac: 5,
      billing_data: { email: "real@person.com", phone_number: "+201234567890" },
      customerMobile: "01234567890",
      source_data: { pan: "2346" },
      maskedCard: "512345******9876",
      note: "contact real@person.com with sk_test_abcdef",
      signatureKeys: ["amount"],
      ok: true,
      list: [{ secretKey: "x" }],
    });
    expect(out).toEqual({
      token: "REDACTED",
      client_secret: "REDACTED",
      hmac: 0,
      billing_data: { email: "customer@example.com", phone_number: "+201000000000" },
      customerMobile: "01000000000",
      source_data: { pan: "1111" },
      maskedCard: "411111******1111",
      note: "contact customer@example.com with sk_test_REDACTED",
      signatureKeys: ["amount"],
      ok: true,
      list: [{ secretKey: "REDACTED" }],
    });
    expect(scrub({ token: "t" }, { keep: ["token"] })).toEqual({ token: "t" });
  });

  it("scrubs card tokens, extended masked PANs and IP addresses", () => {
    const out = scrub({
      cardDataToken: "c",
      ccvToken: "56196e5b-0c1a-4077-bda9-fc9967348b8e",
      extendedMaskedCard: "45087500****1019",
      termsAndConditions: { ip: "41.33.238.154" },
      note: "from 41.33.238.154",
      signatureKeys: ["transactionResponseCode"],
    });
    expect(out).toEqual({
      cardDataToken: "REDACTED",
      ccvToken: "REDACTED",
      extendedMaskedCard: "411111******1111",
      termsAndConditions: { ip: "203.0.113.1" },
      note: "from 203.0.113.1",
      signatureKeys: ["transactionResponseCode"],
    });
  });

  it("scrubs card masks anywhere, cardholder names, merchant ids and tunnel URLs", () => {
    const out = scrub({
      card: { number: "450875******1019", nameOnCard: "Real Person" },
      merchantId: "MID-30045-738",
      merchantDetails: { storeName: "Real Store" },
      apiKeyId: "6737a6254023aa00135c9e45",
      reconciliation: {
        webhookUrl: "https://sight-attended-entities-ripe.trycloudflare.com/webhooks/kashier",
      },
    });
    expect(out).toEqual({
      card: { number: "411111******1111", nameOnCard: "Test Cardholder" },
      merchantId: "MERCHANT_ID",
      merchantDetails: { storeName: "Test Store" },
      apiKeyId: "REDACTED",
      reconciliation: { webhookUrl: "https://example.com/webhooks/kashier" },
    });
  });

  it("scrubs the dashboard user and merchant id recorded on a void", () => {
    const out = scrub({
      metaData: {
        kashier_user: { fullName: "Real Person", email: "real@person.com", selectedMID: "MID-30045-738" },
      },
      note: "merchant MID-30045-738",
    });
    expect(out).toEqual({
      metaData: {
        kashier_user: { fullName: "Test User", email: "customer@example.com", selectedMID: "MERCHANT_ID" },
      },
      note: "merchant MERCHANT_ID",
    });
  });

  it("scrubs URLs", () => {
    expect(scrubUrl("https://x.test/?publicKey=pk&clientSecret=cs&a=1")).toBe(
      "https://x.test/?publicKey=REDACTED&clientSecret=REDACTED&a=1",
    );
    expect(scrubUrl("nope")).toBe("nope");
  });
});

describe("resign", () => {
  const pay = new Sarraf({
    logger: silentLogger,
    providers: {
      paymob: paymob({
        secretKey: "s",
        publicKey: "p",
        hmacSecret: TEST_SECRETS.paymob,
        integrationIds: { card: 1 },
      }),
      kashier: kashier({ merchantId: "MID-1", apiKey: TEST_SECRETS.kashier }),
      fawry: fawry({ merchantCode: "M", secureKey: TEST_SECRETS.fawry, confirmWithStatusQuery: false }),
    },
  });

  it("produces fixtures that verify with the test secret after scrubbing", async () => {
    const cases = [
      ["paymob", signPaymobCallback(paymobTransaction(), "REAL_SECRET")],
      [
        "kashier",
        signKashierWebhook("pay", kashierWebhookData({ merchantOrderId: "real@person.com" }), "REAL"),
      ],
      ["fawry", signFawryNotification(fawryNotification(), "REAL")],
    ] as const;
    for (const [provider, real] of cases) {
      const out = resign(provider, real);
      expect((await pay.webhooks.inspect(provider, out.webhook)).valid).toBe(true);
      expect(out.signedString).toBeTruthy();
      expect(out.expectedSignature).toMatch(/^[0-9a-f]{64,128}$/);
      expect(JSON.stringify(out.webhook)).not.toContain("REAL");
    }
    const bytes = signPaymobCallback(paymobTransaction(), "x");
    expect(
      resign("paymob", { ...bytes, rawBody: new TextEncoder().encode(bytes.rawBody as string) }).webhook,
    ).toBeTruthy();
  });

  it("re-signs redirects so they verify with the test secret, keeping param order", async () => {
    const real = signKashierRedirect(
      { paymentStatus: "SUCCESS", merchantOrderId: "o1", customerEmail: "real@person.com", mode: "test" },
      "REAL",
    );
    const out = resignRedirect("kashier", real);
    expect(Object.keys(out.query)).toEqual([
      "paymentStatus",
      "merchantOrderId",
      "customerEmail",
      "mode",
      "signature",
    ]);
    expect(JSON.stringify(out.query)).not.toContain("real@person.com");
    expect((await pay.redirects.verify("kashier", out.query)).authenticated).toBe(true);
    const paymobOut = resignRedirect("paymob", { success: "true", hmac: "REAL" });
    expect(paymobOut.query.hmac).not.toBe("REAL");
    expect(resignRedirect("fawry", { merchantRefNumber: "o1" }).query).toEqual({ merchantRefNumber: "o1" });
  });
});

describe("isPlaceholder", () => {
  it("treats unfilled values from .env.sandbox.example as missing", () => {
    expect(isPlaceholder("sk_test_...")).toBe(true);
    expect(isPlaceholder("MID-...")).toBe(true);
    expect(isPlaceholder("sk_test_abc123")).toBe(false);
  });
});
