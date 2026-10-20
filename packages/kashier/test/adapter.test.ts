import { Sarraf, silentLogger } from "@sarraf/core";
import { runConformanceTests } from "@sarraf/core/conformance";
import { type MockRoute, createMockFetch, loadFixture } from "@sarraf/testing";
import { describe, expect, it, vi } from "vitest";
import {
  KASHIER_STATUS_TABLE,
  type KashierOptions,
  formatKashierAmount,
  kashier,
  kashierOrderHash,
  mapKashierStatus,
  toKashierPayment,
} from "../src/index.js";
import { kashierWebhookData, signKashierRedirect, signKashierWebhook } from "../src/testing.js";

const API_KEY = "test_api_key";
const options: KashierOptions = { merchantId: "MID-1-1", apiKey: API_KEY, secretKey: "sec_1", mode: "test" };

const orderResponse = (over = {}) => ({ status: "SUCCESS", response: { ...kashierWebhookData(), ...over } });

function routes(): MockRoute[] {
  return [
    { method: "GET", url: /\/v3\/orders\/[^/]+$/, respond: { body: orderResponse() } },
    {
      method: "PUT",
      url: /\/v3\/orders\/.+\/$/,
      respond: { body: { status: "SUCCESS", response: { status: "SUCCESS", transactionId: "TX-REF-1" } } },
    },
    {
      method: "POST",
      url: "/v3/payment/sessions",
      respond: {
        status: 201,
        body: { _id: "sess_1", sessionUrl: "https://payments.kashier.io/session/sess_1" },
      },
    },
  ];
}

function setup(extra: Partial<KashierOptions> = {}, r = routes(), sarrafOpts = {}) {
  const fetch = createMockFetch(r);
  const sarraf = new Sarraf({
    providers: { kashier: kashier({ ...options, ...extra }) },
    http: { fetch, sleep: async () => {} },
    logger: silentLogger,
    allowBeta: true,
    ...sarrafOpts,
  });
  return { sarraf, fetch };
}

const checkoutInput = {
  provider: "kashier" as const,
  amount: { value: 25000, currency: "EGP" as const },
  reference: "order_8841",
  customer: { name: "Sara Ali", email: "sara@example.com", phone: "+201001234567" },
  returnUrl: "https://shop.example.com/thanks",
  webhookUrl: "https://shop.example.com/api/webhooks/kashier",
  methods: ["card" as const, "wallet" as const],
};

runConformanceTests("kashier", () => {
  const { sarraf } = setup();
  let calls = 0;
  const provider = sarraf.provider("kashier");
  const original = provider.createCheckout.bind(provider);
  provider.createCheckout = (i, c) => {
    calls++;
    return original(i, c);
  };
  const succeeded = signKashierWebhook("pay", kashierWebhookData(), API_KEY);
  return {
    sarraf,
    provider: "kashier",
    checkoutInput,
    expectedCheckoutKind: "redirect",
    webhooks: {
      succeeded,
      tampered: {
        ...succeeded,
        rawBody: (succeeded.rawBody as string).replace('"amount":250', '"amount":1'),
      },
      refunded: signKashierWebhook(
        "refund",
        kashierWebhookData({ transactionId: "TX-R", amount: 250, totalRefundedAmount: 250 }),
        API_KEY,
      ),
    },
    lookup: { providerPaymentId: "ko_6527a1b2c3" },
    refund: { providerPaymentId: "ko_6527a1b2c3", amount: { value: 10000, currency: "EGP" } },
    fetchCalls: () => calls,
  };
});

describe("kashier config", () => {
  it("validates and resolves URLs", () => {
    expect(() => kashier({ ...options, apiKey: "" })).toThrow(/apiKey is required/);
    const live = kashier({ ...options, mode: "live" });
    expect(live.config.urls.fep).toBe("https://fep.kashier.io");
    const custom = kashier({ ...options, urls: { checkout: "https://c.test/" }, currencies: ["EGP"] });
    expect(custom.config.urls.checkout).toBe("https://c.test");
    expect(custom.capabilities.currencies).toEqual(["EGP"]);
  });

  it("marks server APIs beta with a secret key, unsupported without", () => {
    expect(kashier(options).capabilities.refund).toBe("beta");
    expect(kashier({ ...options, secretKey: undefined }).capabilities.refund).toBe("unsupported");
  });
});

describe("kashier HPP checkout", () => {
  it("builds a signed hosted-page URL using the same amount string in hash and URL", async () => {
    const { sarraf } = setup();
    const c = await sarraf.checkout.create({
      ...checkoutInput,
      metadata: { cart: "c1" },
      expiresInSeconds: 60,
    });
    const url = new URL(c.redirectUrl!);
    expect(url.origin).toBe("https://checkout.kashier.io");
    const p = Object.fromEntries(url.searchParams);
    expect(p).toMatchObject({
      merchantId: "MID-1-1",
      orderId: "order_8841",
      amount: "250.00",
      currency: "EGP",
      mode: "test",
      merchantRedirect: checkoutInput.returnUrl,
      serverWebhook: checkoutInput.webhookUrl,
      allowedMethods: "card,wallet",
      display: "en",
      metaData: '{"cart":"c1"}',
    });
    expect(p.hash).toBe(
      kashierOrderHash(
        { merchantId: "MID-1-1", orderId: "order_8841", amount: p.amount!, currency: "EGP" },
        API_KEY,
      ),
    );
    expect(c.id).toBe("kashier_order_8841");
    expect(c.expiresAt).toBeTruthy();
  });

  it("supports trimmed amounts, locale, raw allowedMethods and extra params", async () => {
    const { sarraf } = setup({ amountFormat: "trimmed" });
    const c = await sarraf.checkout.create({
      ...checkoutInput,
      locale: "ar",
      methods: undefined,
      providerOptions: {
        allowedMethods: "card",
        extraParams: { brandColor: "#000" },
        customerReference: "cust1",
      },
    });
    const p = Object.fromEntries(new URL(c.redirectUrl!).searchParams);
    expect(p).toMatchObject({
      amount: "250",
      display: "ar",
      allowedMethods: "card",
      brandColor: "#000",
      customerReference: "cust1",
    });
    expect(p.hash).toBe(
      kashierOrderHash(
        {
          merchantId: "MID-1-1",
          orderId: "order_8841",
          amount: "250",
          currency: "EGP",
          customerReference: "cust1",
        },
        API_KEY,
      ),
    );
  });

  it("maps installments/bnpl and defaults to card,wallet", async () => {
    const { sarraf } = setup();
    const c = await sarraf.checkout.create({ ...checkoutInput, methods: ["installments", "bnpl"] });
    expect(new URL(c.redirectUrl!).searchParams.get("allowedMethods")).toBe("bank_installments,valu");
    const d = await sarraf.checkout.create({ ...checkoutInput, methods: undefined });
    expect(new URL(d.redirectUrl!).searchParams.get("allowedMethods")).toBe("card,wallet");
  });

  it("requires allowBeta for beta methods and rejects unknown ones", async () => {
    const { sarraf } = setup({}, routes(), { allowBeta: false });
    await expect(sarraf.checkout.create({ ...checkoutInput, methods: ["installments"] })).rejects.toThrow(
      /beta/,
    );
    const p = kashier(options);
    await expect(
      p.createCheckout({ ...checkoutInput, methods: ["cash_outlet"] }, sarraf.ctx),
    ).rejects.toThrow(/does not support method "cash_outlet"/);
  });
});

describe("kashier sessions flow (beta)", () => {
  it("creates a session with both auth headers", async () => {
    const warn = vi.fn();
    const { sarraf, fetch } = setup({}, routes(), { logger: { ...silentLogger, warn } });
    const c = await sarraf.checkout.create({ ...checkoutInput, providerOptions: { flow: "session" } });
    expect(c.redirectUrl).toBe("https://payments.kashier.io/session/sess_1");
    expect(c.id).toBe("kashier_sess_1");
    const call = fetch.calls[0]!;
    expect(call.url.origin).toBe("https://test-api.kashier.io");
    expect(call.headers.authorization).toBe("sec_1");
    expect(call.headers["api-key"]).toBe(API_KEY);
    expect(call.json).toMatchObject({
      amount: "250.00",
      currency: "EGP",
      order: "order_8841",
      merchantId: "MID-1-1",
    });
    expect(warn).toHaveBeenCalled();
  });

  it("fails clearly without a secret key or a session URL", async () => {
    const noSecret = setup({ secretKey: undefined });
    await expect(
      noSecret.sarraf.checkout.create({
        ...checkoutInput,
        customer: { phone: "+201001234567" },
        providerOptions: { flow: "session" },
        expiresInSeconds: 30,
      }),
    ).rejects.toThrow(/secretKey is required for payment sessions/);
    const bad = setup({}, [{ method: "POST", url: "/v3/payment/sessions", respond: { body: {} } }]);
    await expect(
      bad.sarraf.checkout.create({ ...checkoutInput, providerOptions: { flow: "session" } }),
    ).rejects.toThrow(/no sessionUrl/);
  });
});

describe("kashier getPayment / refund (beta)", () => {
  it("gets an order", async () => {
    const { sarraf, fetch } = setup();
    const p = await sarraf.payments.get({ provider: "kashier", reference: "order_8841" });
    expect(p.status).toBe("succeeded");
    expect(fetch.calls[0]!.url.pathname).toBe("/v3/orders/order_8841");
    expect(fetch.calls[0]!.headers.authorization).toBe("sec_1");
  });

  it("reports NOT_FOUND and provider messages", async () => {
    const empty = setup({}, [{ method: "GET", url: /orders/, respond: { body: {} } }]);
    await expect(empty.sarraf.payments.get({ provider: "kashier", reference: "x" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const err = setup({}, [
      { method: "GET", url: /orders/, respond: { status: 400, body: { message: "bad order" } } },
    ]);
    await expect(err.sarraf.payments.get({ provider: "kashier", reference: "x" })).rejects.toThrow(
      /bad order/,
    );
    const err2 = setup({}, [
      { method: "GET", url: /orders/, respond: { status: 400, body: { error: { code: 1 } } } },
    ]);
    await expect(err2.sarraf.payments.get({ provider: "kashier", reference: "x" })).rejects.toThrow(
      /"code":1/,
    );
  });

  it("refunds a partial amount", async () => {
    const { sarraf, fetch } = setup();
    const r = await sarraf.refunds.create({
      provider: "kashier",
      providerPaymentId: "ko_1",
      amount: { value: 10000, currency: "EGP" },
      reason: "damaged",
    });
    expect(fetch.calls[0]!.method).toBe("PUT");
    expect(fetch.calls[0]!.json).toEqual({
      apiOperation: "REFUND",
      reason: "damaged",
      transaction: { amount: 100 },
    });
    expect(r).toMatchObject({ status: "succeeded", providerRefundId: "TX-REF-1" });
  });

  it("refunds the remaining amount and reports pending / failed", async () => {
    const r = routes();
    r[0] = {
      method: "GET",
      url: /\/v3\/orders\/[^/]+$/,
      respond: { body: orderResponse({ totalRefundedAmount: 50 }) },
    };
    const { sarraf, fetch } = setup({}, r);
    const refund = await sarraf.refunds.create({ provider: "kashier", providerPaymentId: "ko_1" });
    expect(fetch.calls[1]!.json).toMatchObject({ transaction: { amount: 200 }, reason: "Refund" });
    expect(refund.amount).toEqual({ value: 20000, currency: "EGP" });
    const pending = setup({}, [{ method: "PUT", url: /orders/, respond: { body: { status: "PENDING" } } }]);
    const p = await pending.sarraf.refunds.create({
      provider: "kashier",
      providerPaymentId: "ko_1",
      amount: { value: 100, currency: "EGP" },
    });
    expect(p.status).toBe("pending");
    expect(p.id).toBe("kashier_refund_ko_1");
    const failed = setup({}, [
      { method: "PUT", url: /orders/, respond: { body: { response: { status: "FAILURE" } } } },
    ]);
    expect(
      (
        await failed.sarraf.refunds.create({
          provider: "kashier",
          providerPaymentId: "ko_1",
          amount: { value: 100, currency: "EGP" },
        })
      ).status,
    ).toBe("failed");
  });

  it("requires allowBeta for refunds", async () => {
    const { sarraf } = setup({}, routes(), { allowBeta: false });
    await expect(sarraf.refunds.create({ provider: "kashier", providerPaymentId: "ko_1" })).rejects.toThrow(
      /Kashier refund is beta/,
    );
  });
});

describe("kashier webhooks", () => {
  it("verifies recorded fixtures", async () => {
    for (const scenario of ["webhook-pay-success", "webhook-special-chars"]) {
      const f = loadFixture("kashier", scenario);
      const { sarraf } = setup({ apiKey: f.secret! });
      const e = await sarraf.webhooks.verifyAndParse("kashier", f.webhook!);
      expect(e.type).toBe("payment.succeeded");
    }
    const f = loadFixture("kashier", "webhook-refund-partial");
    const { sarraf } = setup({ apiKey: f.secret! });
    const e = await sarraf.webhooks.verifyAndParse("kashier", f.webhook!);
    expect(e.type).toBe("refund.succeeded");
    expect(e.payment.status).toBe("partially_refunded");
    expect(e.payment.amountRefunded.value).toBe(10000);
    expect(e.payment.amount.value).toBe(25000);
    expect(e.id).toBe("kashier:TX-2491820499:refund:partially_refunded");
  });

  it("parses failures with messages and card details", async () => {
    const f = loadFixture("kashier", "webhook-pay-failed");
    const { sarraf } = setup({ apiKey: f.secret! });
    const e = await sarraf.webhooks.verifyAndParse("kashier", f.webhook!);
    expect(e.type).toBe("payment.failed");
    expect(e.payment.failure).toEqual({
      code: "PAYMENT_DECLINED",
      message: "Do not honor",
      providerCode: "05",
    });
    expect(e.payment.card).toEqual({ last4: "1111", brand: "Visa" });
  });

  it("emits refund.failed and defaults the event to pay", async () => {
    const { sarraf } = setup();
    const e = await sarraf.webhooks.verifyAndParse(
      "kashier",
      signKashierWebhook("refund", kashierWebhookData({ status: "FAILED" }), API_KEY),
    );
    expect(e.type).toBe("refund.failed");
    const raw = { data: kashierWebhookData() };
    const signed = signKashierWebhook("pay", raw.data, API_KEY);
    const noEvent = await sarraf.webhooks.verifyAndParse("kashier", {
      ...signed,
      rawBody: JSON.stringify(raw),
    });
    expect(noEvent.type).toBe("payment.succeeded");
  });

  it("explains rejections", async () => {
    const { sarraf } = setup();
    const ok = signKashierWebhook("pay", kashierWebhookData(), API_KEY);
    expect((await sarraf.webhooks.inspect("kashier", { ...ok, headers: {} })).reason).toMatch(
      /missing x-kashier-signature/,
    );
    expect((await sarraf.webhooks.inspect("kashier", { ...ok, rawBody: "nope" })).reason).toMatch(
      /not valid JSON/,
    );
    expect((await sarraf.webhooks.inspect("kashier", { ...ok, rawBody: '{"data":{}}' })).reason).toMatch(
      /signatureKeys/,
    );
    await expect(
      sarraf.webhooks.verifyAndParse("kashier", { ...ok, headers: { "x-kashier-signature": "00" } }),
    ).rejects.toThrow(/signature mismatch/);
  });
});

describe("kashier redirect", () => {
  const query = {
    paymentStatus: "SUCCESS",
    merchantOrderId: "order_8841",
    orderId: "ko_1",
    amount: "250.00",
    currency: "EGP",
    mode: "test",
  };

  it("authenticates signed params", async () => {
    const { sarraf } = setup();
    const r = await sarraf.redirects.verify("kashier", signKashierRedirect(query, API_KEY));
    expect(r).toMatchObject({
      authenticated: true,
      status: "succeeded",
      reference: "order_8841",
      providerPaymentId: "ko_1",
    });
  });

  it("flags tampering and handles odd params", async () => {
    const { sarraf } = setup();
    const signed = signKashierRedirect(query, API_KEY);
    expect(
      (await sarraf.redirects.verify("kashier", { ...signed, paymentStatus: "FAILURE" })).authenticated,
    ).toBe(false);
    const r = await sarraf.redirects.verify("kashier", { amount: "bad", currency: "XXX" });
    expect(r.status).toBe("unknown");
    expect(r.authenticated).toBe(false);
    const p = kashier(options);
    expect((await p.verifyRedirect({ paymentStatus: "FAILURE" })).status).toBe("failed");
  });
});

describe("kashier status mapping (one test per table row)", () => {
  const amount = { value: 100, currency: "EGP" as const };
  const rows: [string | undefined, string | undefined, string, Parameters<typeof mapKashierStatus>[2]?][] = [
    ["pay", "SUCCESS", "succeeded"],
    ["pay", "PENDING", "pending"],
    ["pay", "INITIATED", "pending"],
    ["pay", undefined, "pending"],
    ["pay", "FAILURE", "failed"],
    ["pay", "FAILED", "failed"],
    ["pay", "DECLINED", "failed"],
    ["authorize", "SUCCESS", "requires_action"],
    ["capture", "SUCCESS", "succeeded"],
    ["refund", "SUCCESS", "partially_refunded", { amount, refunded: { value: 50, currency: "EGP" } }],
    ["refund", "SUCCESS", "refunded", { amount, refunded: amount }],
    ["refund", "SUCCESS", "refunded"],
    ["void", "SUCCESS", "canceled"],
    ["pay", "EXPIRED", "expired"],
    ["pay", "CANCELLED", "canceled"],
    [undefined, "APPROVED", "succeeded"],
    ["pay", "WEIRD", "pending"],
  ];
  for (const [event, status, expected, refund] of rows) {
    it(`${event} ${status} → ${expected}`, () =>
      expect(mapKashierStatus(event, status, refund)).toBe(expected));
  }
  it("table covers every mapped status", () => {
    const statuses = new Set(KASHIER_STATUS_TABLE.map((r) => r.status));
    for (const [, , expected] of rows) expect(statuses.has(expected as never)).toBe(true);
  });
});

describe("kashier mappers", () => {
  it("formats amounts", () => {
    expect(formatKashierAmount(25000, "EGP", { amountFormat: "fixed" })).toBe("250.00");
    expect(formatKashierAmount(25050, "EGP", { amountFormat: "trimmed" })).toBe("250.5");
  });

  it("maps payments with fallbacks", () => {
    const p = toKashierPayment(
      {
        transactionId: "t1",
        status: "SUCCESS",
        amount: "10.5",
        currency: "XXX",
        method: "wallet",
        maskedCard: undefined,
        transactionResponseMessage: "ok",
      },
      undefined,
      "USD",
    );
    expect(p).toMatchObject({
      providerPaymentId: "t1",
      reference: "",
      amount: { value: 1050, currency: "USD" },
      method: "wallet",
    });
    expect(p.card).toBeUndefined();
    const failed = toKashierPayment({ status: "FAILURE", transactionResponseMessage: "nope" }, "pay", "EGP");
    expect(failed.failure?.message).toBe("nope");
    expect(failed.amount.value).toBe(0);
    expect(failed.providerPaymentId).toBe("");
    expect(toKashierPayment({ status: "FAILURE" }, "pay", "EGP").failure?.message).toBe("Payment failed");
    expect(
      toKashierPayment({ status: "SUCCESS", amount: 1, refundedAmount: 0.5 }, "pay", "EGP").amountRefunded
        .value,
    ).toBe(50);
    for (const [m, e] of [
      ["installments", "installments"],
      ["valu", "bnpl"],
      ["bank", "bank_transfer"],
      ["x", "other"],
    ]) {
      expect(toKashierPayment({ method: m }, "pay", "EGP").method).toBe(e);
    }
    expect(toKashierPayment({ cardBrand: "MC" }, "pay", "EGP").card).toEqual({
      last4: undefined,
      brand: "MC",
    });
  });
});
