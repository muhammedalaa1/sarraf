import { assertPaymentEvent, Sarraf, silentLogger } from "@sarraf/core";
import { runConformanceTests } from "@sarraf/core/conformance";
import { createMockFetch, loadFixture, type MockRoute } from "@sarraf/testing";
import { describe, expect, it, vi } from "vitest";
import {
  FAWRY_STATUS_TABLE,
  type FawryOptions,
  fawry,
  fawryChargeSignature,
  fawryStatusSignature,
  mapFawryMethod,
  mapFawryStatus,
  toFawryMobile,
  toFawryPayment,
} from "../src/index.js";
import { fawryNotification, signFawryNotification } from "../src/testing.js";

const KEY = "test_secure_key";
const options: FawryOptions = { merchantCode: "TESTMERCHANT01", secureKey: KEY, environment: "staging" };

const statusBody = (over = {}) => ({
  type: "PaymentStatusResponse",
  referenceNumber: "970177",
  merchantRefNumber: "order_8841",
  paymentAmount: 250,
  orderAmount: 250,
  paymentMethod: "PAYATFAWRY",
  orderStatus: "PAID",
  paymentTime: 1760960000000,
  statusCode: 200,
  statusDescription: "Operation done successfully",
  ...over,
});

function routes(status = statusBody()): MockRoute[] {
  return [
    {
      method: "POST",
      url: "/ECommerceWeb/Fawry/payments/charge",
      respond: {
        body: {
          type: "ChargeResponse",
          referenceNumber: "970177",
          merchantRefNumber: "order_8841",
          expirationTime: 1761046400000,
          statusCode: 200,
          statusDescription: "Operation done successfully",
        },
      },
    },
    { method: "GET", url: /\/ECommerceWeb\/Fawry\/payments\/status\/v2/, respond: { body: status } },
    {
      method: "POST",
      url: "/ECommerceWeb/Fawry/payments/refund",
      respond: {
        body: {
          type: "ResponseDataModel",
          statusCode: 200,
          statusDescription: "Operation done successfully",
        },
      },
    },
    {
      method: "POST",
      url: "/ECommerceWeb/api/orders/cancel-unpaid-order",
      respond: { body: { statusCode: 200, statusDescription: "Operation done successfully" } },
    },
    {
      method: "POST",
      url: "/fawrypay-api/api/payments/init",
      respond: { body: "https://atfawry.fawrystaging.com/atfawry/plugin/redirect?ref=abc" },
    },
  ];
}

function setup(extra: Partial<FawryOptions> = {}, r = routes(), sarrafOpts = {}) {
  const fetch = createMockFetch(r);
  const sarraf = new Sarraf({
    providers: { fawry: fawry({ ...options, ...extra }) },
    http: { fetch, sleep: async () => {} },
    logger: silentLogger,
    allowBeta: true,
    now: () => new Date("2026-10-20T12:00:00Z"),
    ...sarrafOpts,
  });
  return { sarraf, fetch };
}

const checkoutInput = {
  provider: "fawry" as const,
  amount: { value: 25000, currency: "EGP" as const },
  reference: "order_8841",
  customer: { name: "Sara Ali", email: "sara@example.com", phone: "+201001234567" },
};

runConformanceTests("fawry", () => {
  const { sarraf, fetch } = setup();
  const succeeded = signFawryNotification(fawryNotification(), KEY);
  return {
    sarraf,
    provider: "fawry",
    checkoutInput,
    expectedCheckoutKind: "reference_code",
    webhooks: {
      succeeded,
      tampered: {
        ...succeeded,
        rawBody: (succeeded.rawBody as string).replace('"orderAmount":250', '"orderAmount":2'),
      },
    },
    lookup: { reference: "order_8841" },
    refund: { providerPaymentId: "970177", amount: { value: 10000, currency: "EGP" } },
    fetchCalls: () => fetch.callsTo("POST", "/ECommerceWeb/Fawry/payments/charge").length,
  };
});

describe("fawry config", () => {
  it("validates and resolves", () => {
    expect(() => fawry({ ...options, secureKey: "" })).toThrow(/secureKey is required/);
    expect(fawry({ ...options, environment: "production" }).config.baseUrl).toBe("https://www.atfawry.com");
    expect(fawry({ ...options, baseUrl: "https://x.test/" }).config.baseUrl).toBe("https://x.test");
    expect(fawry(options).config.confirmWithStatusQuery).toBe(true);
  });
});

describe("fawry PAYATFAWRY checkout", () => {
  it("sends a signed charge and returns a reference code", async () => {
    const { sarraf, fetch } = setup();
    const c = await sarraf.checkout.create({ ...checkoutInput, expiresInSeconds: 86400 });
    const body = fetch.calls[0]!.json as Record<string, unknown>;
    expect(body).toMatchObject({
      merchantCode: "TESTMERCHANT01",
      merchantRefNum: "order_8841",
      customerMobile: "01001234567",
      customerEmail: "sara@example.com",
      customerName: "Sara Ali",
      paymentMethod: "PAYATFAWRY",
      amount: 250,
      currencyCode: "EGP",
      description: "Order order_8841",
      paymentExpiry: new Date("2026-10-21T12:00:00Z").getTime(),
      chargeItems: [{ itemId: "order_8841", description: "Order order_8841", price: 250, quantity: 1 }],
      language: "en-gb",
    });
    expect(body.signature).toBe(
      fawryChargeSignature(
        {
          merchantCode: "TESTMERCHANT01",
          merchantRefNum: "order_8841",
          paymentMethod: "PAYATFAWRY",
          amount: "250.00",
        },
        KEY,
      ).signature,
    );
    expect(c).toMatchObject({
      id: "fawry_970177",
      kind: "reference_code",
      referenceCode: "970177",
      expiresAt: new Date(1761046400000).toISOString(),
      payment: { status: "awaiting_payment", method: "cash_outlet", providerPaymentId: "970177" },
    });
  });

  it("maps items, profile id, Arabic and expiry fallback", async () => {
    const r = routes();
    r[0] = {
      method: "POST",
      url: "/ECommerceWeb/Fawry/payments/charge",
      respond: { body: { referenceNumber: 1, statusCode: 200 } },
    };
    const { sarraf, fetch } = setup({}, r);
    const c = await sarraf.checkout.create({
      ...checkoutInput,
      locale: "ar",
      expiresInSeconds: 60,
      items: [
        { name: "Mug", unitAmount: { value: 5000, currency: "EGP" }, quantity: 2, sku: "mug" },
        { name: "Tee", unitAmount: { value: 15000, currency: "EGP" }, quantity: 1 },
      ],
      providerOptions: { customerProfileId: "cust_77", description: "Cart" },
    });
    const body = fetch.calls[0]!.json as Record<string, unknown>;
    expect(body.chargeItems).toEqual([
      { itemId: "mug", description: "Mug", price: 50, quantity: 2 },
      { itemId: "item2", description: "Tee", price: 150, quantity: 1 },
    ]);
    expect(body).toMatchObject({ customerProfileId: "cust_77", language: "ar-eg", description: "Cart" });
    expect(c.expiresAt).toBe("2026-10-20T12:01:00.000Z");
    const none = await setup({}, r).sarraf.checkout.create(checkoutInput);
    expect(none.expiresAt).toBeUndefined();
  });

  it("maps Fawry statusCode errors", async () => {
    const err = (code: number, statusDescription: string) =>
      setup({}, [
        {
          method: "POST",
          url: "/ECommerceWeb/Fawry/payments/charge",
          respond: { body: { statusCode: code, statusDescription } },
        },
      ]).sarraf.checkout.create(checkoutInput);
    await expect(err(9946, "Duplicate merchantRefNum")).rejects.toMatchObject({
      code: "DUPLICATE_REFERENCE",
      providerCode: "9946",
    });
    await expect(err(9901, "Merchant not found")).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    await expect(err(9999, "Order not found")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(err(9000, "Something")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(err(9000, undefined as never)).rejects.toThrow(/unknown error/);
    const http = setup({}, [
      {
        method: "POST",
        url: "/ECommerceWeb/Fawry/payments/charge",
        respond: { status: 500, body: { description: "down" } },
      },
    ]);
    await expect(http.sarraf.checkout.create(checkoutInput)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    const noRef = setup({}, [
      { method: "POST", url: "/ECommerceWeb/Fawry/payments/charge", respond: { body: { statusCode: 200 } } },
    ]);
    await expect(noRef.sarraf.checkout.create(checkoutInput)).rejects.toThrow(/no referenceNumber/);
  });
});

describe("fawry hosted checkout (beta)", () => {
  it("returns the hosted URL for card", async () => {
    const { sarraf, fetch } = setup();
    const c = await sarraf.checkout.create({
      ...checkoutInput,
      methods: ["card"],
      returnUrl: "https://shop.example.com/thanks",
      expiresInSeconds: 600,
    });
    expect(c).toMatchObject({
      kind: "redirect",
      redirectUrl: expect.stringContaining("atfawry"),
      payment: { method: "card", status: "pending" },
    });
    expect(c.expiresAt).toBe("2026-10-20T12:10:00.000Z");
    expect(fetch.calls[0]!.json).toMatchObject({
      paymentMethod: "CARD",
      returnUrl: "https://shop.example.com/thanks",
      authCaptureModePayment: false,
    });
    const w = await sarraf.checkout.create({
      ...checkoutInput,
      methods: ["wallet"],
      returnUrl: "https://s.test/r",
    });
    expect(w.payment.method).toBe("wallet");
    const both = await sarraf.checkout.create({
      ...checkoutInput,
      methods: ["card", "wallet"],
      returnUrl: "https://s.test/r",
    });
    expect((fetch.calls[2]!.json as Record<string, unknown>).paymentMethod).toBeUndefined();
    expect(both.expiresAt).toBeUndefined();
  });

  it("accepts a JSON url response and validates input", async () => {
    const { sarraf } = setup({}, [
      {
        method: "POST",
        url: "/fawrypay-api/api/payments/init",
        respond: { body: { url: "https://pay.test/x" } },
      },
    ]);
    const c = await sarraf.checkout.create({
      ...checkoutInput,
      methods: ["card"],
      returnUrl: "https://s.test/r",
    });
    expect(c.redirectUrl).toBe("https://pay.test/x");
    await expect(sarraf.checkout.create({ ...checkoutInput, methods: ["card"] })).rejects.toThrow(
      /needs returnUrl/,
    );
    await expect(
      sarraf.checkout.create({
        ...checkoutInput,
        methods: ["card", "cash_outlet"],
        returnUrl: "https://s.test/r",
      }),
    ).rejects.toThrow(/separately/);
    const bad = setup({}, [
      { method: "POST", url: "/fawrypay-api/api/payments/init", respond: { body: "nope" } },
    ]);
    await expect(
      bad.sarraf.checkout.create({ ...checkoutInput, methods: ["card"], returnUrl: "https://s.test/r" }),
    ).rejects.toThrow(/no checkout URL/);
  });

  it("requires allowBeta", async () => {
    const { sarraf } = setup({}, routes(), { allowBeta: false });
    await expect(sarraf.checkout.create({ ...checkoutInput, methods: ["card"] })).rejects.toThrow(/beta/);
  });
});

describe("fawry status / refund / cancel", () => {
  it("queries status with the status signature", async () => {
    const { sarraf, fetch } = setup();
    const p = await sarraf.payments.reconcile({ provider: "fawry", reference: "order_8841" });
    const q = fetch.calls[0]!.url.searchParams;
    expect(q.get("merchantRefNumber")).toBe("order_8841");
    expect(q.get("signature")).toBe(fawryStatusSignature("TESTMERCHANT01", "order_8841", KEY).signature);
    expect(p).toMatchObject({
      status: "succeeded",
      providerPaymentId: "970177",
      amount: { value: 25000 },
      method: "cash_outlet",
    });
    await expect(sarraf.payments.get({ provider: "fawry", providerPaymentId: "970177" })).rejects.toThrow(
      /needs the merchant reference/,
    );
  });

  it("refunds partial and remaining amounts", async () => {
    const { sarraf, fetch } = setup();
    const r = await sarraf.refunds.create({
      provider: "fawry",
      providerPaymentId: "970177",
      amount: { value: 10000, currency: "EGP" },
      reason: "damaged",
    });
    expect(fetch.calls[0]!.json).toMatchObject({
      referenceNumber: "970177",
      refundAmount: 100,
      reason: "damaged",
    });
    expect(r.status).toBe("succeeded");
    const full = await sarraf.refunds.create({
      provider: "fawry",
      providerPaymentId: "970177",
      reference: "order_8841",
    });
    expect(full.amount).toEqual({ value: 25000, currency: "EGP" });
    await expect(sarraf.refunds.create({ provider: "fawry", providerPaymentId: "970177" })).rejects.toThrow(
      /needs amount or the merchant reference/,
    );
  });

  it("cancels unpaid references", async () => {
    const { sarraf, fetch } = setup({}, routes(statusBody({ orderStatus: "CANCELED" })));
    const p = await sarraf.payments.cancel({
      provider: "fawry",
      reference: "order_8841",
      providerPaymentId: "970177",
    });
    expect(fetch.calls[0]!.json).toMatchObject({
      merchantAccount: "TESTMERCHANT01",
      orderRefNo: "970177",
      lang: "en-gb",
    });
    expect(p.status).toBe("canceled");
    const byRef = await sarraf.payments.cancel({ provider: "fawry", providerPaymentId: "970177" });
    expect(byRef).toMatchObject({ status: "canceled", providerPaymentId: "970177" });
  });
});

describe("fawry notifications", () => {
  it("verifies recorded fixtures and confirms with a status query", async () => {
    const f = loadFixture("fawry", "notification-paid");
    const { sarraf, fetch } = setup({ secureKey: f.secret! });
    const e = await sarraf.webhooks.verifyAndParse("fawry", f.webhook!);
    assertPaymentEvent(e);
    expect(e).toMatchObject({ id: "fawry:970177:succeeded", type: "payment.succeeded" });
    expect(fetch.callsTo("GET", /status\/v2/)).toHaveLength(1);
  });

  it("trusts the status query over the notification body", async () => {
    const warn = vi.fn();
    const { sarraf } = setup({}, routes(statusBody({ orderStatus: "UNPAID" })), {
      logger: { ...silentLogger, warn },
    });
    const e = await sarraf.webhooks.verifyAndParse("fawry", signFawryNotification(fawryNotification(), KEY));
    assertPaymentEvent(e);
    expect(e.payment.status).toBe("awaiting_payment");
    expect(e.type).toBe("payment.pending");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("differs"), expect.anything());
  });

  it("can skip the status query", async () => {
    const f = loadFixture("fawry", "notification-expired");
    const { sarraf, fetch } = setup({ secureKey: f.secret!, confirmWithStatusQuery: false });
    const e = await sarraf.webhooks.verifyAndParse("fawry", f.webhook!);
    expect(e.type).toBe("payment.expired");
    expect(fetch.calls).toHaveLength(0);
    const card = loadFixture("fawry", "notification-card-paid");
    const c = await sarraf.webhooks.verifyAndParse("fawry", card.webhook!);
    assertPaymentEvent(c);
    expect(c.payment).toMatchObject({ method: "card", amount: { value: 25050 } });
  });

  it("explains rejections, including V1 notifications", async () => {
    const { sarraf } = setup();
    expect((await sarraf.webhooks.inspect("fawry", { rawBody: "x" })).reason).toMatch(/not valid JSON/);
    expect(
      (await sarraf.webhooks.inspect("fawry", { rawBody: '{"FawryRefNo":"1","signature":"md5"}' })).reason,
    ).toMatch(/V1 notification/);
    expect((await sarraf.webhooks.inspect("fawry", { rawBody: "{}" })).reason).toMatch(
      /messageSignature is missing/,
    );
    expect(
      (
        await sarraf.webhooks.inspect("fawry", {
          rawBody: JSON.stringify({ messageSignature: "a", paymentAmount: "x" }),
        })
      ).reason,
    ).toMatch(/cannot build signature/);
    const ok = signFawryNotification(fawryNotification(), KEY);
    const inspection = await sarraf.webhooks.inspect("fawry", ok);
    expect(inspection.signedString).toBe("970177order_8841250.00250.00PAIDPAYATFAWRY2283311<secureKey>");
    await expect(
      sarraf.webhooks.verifyAndParse("fawry", signFawryNotification(fawryNotification(), "wrong")),
    ).rejects.toThrow(/messageSignature mismatch/);
  });
});

describe("fawry mappers", () => {
  const rows: [string | undefined, string | undefined, string][] = [
    ["NEW", "PAYATFAWRY", "awaiting_payment"],
    ["UNPAID", "PAYATFAWRY", "awaiting_payment"],
    ["UNPAID", "CARD", "pending"],
    [undefined, undefined, "pending"],
    ["PAID", "CARD", "succeeded"],
    ["EXPIRED", "PAYATFAWRY", "expired"],
    ["CANCELED", "PAYATFAWRY", "canceled"],
    ["CANCELLED", "PAYATFAWRY", "canceled"],
    ["REFUNDED", "CARD", "refunded"],
    ["PARTIAL_REFUNDED", "CARD", "partially_refunded"],
    ["FAILED", "CARD", "failed"],
  ];
  for (const [status, method, expected] of rows) {
    it(`${status}/${method} → ${expected}`, () => expect(mapFawryStatus(status, method)).toBe(expected));
  }
  it("table covers every mapped status", () => {
    const statuses = new Set(FAWRY_STATUS_TABLE.map((r) => r.status));
    for (const [, , expected] of rows) expect(statuses.has(expected as never)).toBe(true);
  });

  it("maps methods and mobiles", () => {
    expect(mapFawryMethod("MWALLET")).toBe("wallet");
    expect(mapFawryMethod("payatfawry")).toBe("cash_outlet");
    expect(mapFawryMethod("XYZ")).toBe("other");
    expect(mapFawryMethod(undefined)).toBeUndefined();
    expect(toFawryMobile("+20 100 123 4567")).toBe("01001234567");
    expect(toFawryMobile("00201001234567")).toBe("01001234567");
    expect(toFawryMobile("01001234567")).toBe("01001234567");
  });

  it("normalizes refunds, failures and odd payloads", () => {
    const n = fawryNotification();
    expect(toFawryPayment({ ...n, orderStatus: "REFUNDED", refundedAmount: 100 }).status).toBe(
      "partially_refunded",
    );
    expect(toFawryPayment({ ...n, orderStatus: "REFUNDED", refundedAmount: 250 }).status).toBe("refunded");
    expect(toFawryPayment({ ...n, orderStatus: "REFUNDED" }).amountRefunded.value).toBe(25000);
    expect(
      toFawryPayment({ ...n, orderStatus: "FAILED", statusDescription: "Card declined" }).failure?.message,
    ).toBe("Card declined");
    expect(toFawryPayment({ ...n, orderStatus: "FAILED" }).failure?.message).toBe("Payment failed");
    const odd = toFawryPayment({
      referenceNumber: "1",
      merchantRefNum: "r",
      orderAmount: 1,
      paymentTime: "not a date",
    });
    expect(odd).toMatchObject({ providerPaymentId: "1", reference: "r", updatedAt: undefined });
    expect(toFawryPayment({ paymentAmount: 1, paymentTime: "2026-10-20T00:00:00Z" }).updatedAt).toBe(
      "2026-10-20T00:00:00.000Z",
    );
    expect(toFawryPayment({ paymentAmount: 1 }).reference).toBe("");
    expect(() => toFawryPayment({})).toThrow(/no orderAmount/);
  });
});
