import { Sarraf, silentLogger } from "@sarraf/core";
import { fawry } from "@sarraf/fawry";
import { fawryNotification, signFawryNotification } from "@sarraf/fawry/testing";
import { kashier } from "@sarraf/kashier";
import { kashierWebhookData, signKashierWebhook } from "@sarraf/kashier/testing";
import { paymob } from "@sarraf/paymob";
import { paymobTransaction, signPaymobCallback } from "@sarraf/paymob/testing";
import { describe, expect, it } from "vitest";
import { TEST_SECRETS, resign } from "./record-fixtures.js";
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
});
