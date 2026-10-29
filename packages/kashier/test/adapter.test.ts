import { assertPaymentEvent, Sarraf, silentLogger } from "@sarrafjs/core";
import { runConformanceTests } from "@sarrafjs/core/conformance";
import { createMockFetch, loadFixture, type MockRoute } from "@sarrafjs/testing";
import { describe, expect, it, vi } from "vitest";
import {
  formatKashierAmount,
  KASHIER_STATUS_TABLE,
  type KashierOptions,
  kashier,
  kashierOrderHash,
  mapKashierStatus,
  toKashierPayment,
} from "../src/index.js";
import { kashierWebhookData, signKashierRedirect, signKashierWebhook } from "../src/testing.js";

const API_KEY = "test_api_key";
const options: KashierOptions = { merchantId: "MID-1-1", apiKey: API_KEY, secretKey: "sec_1", mode: "test" };

/** An order as the order lookup returns it (shape from fixtures/kashier/sandbox-order-partially-refunded.json). */
const kashierOrder = (over: Record<string, unknown> = {}) => ({
  orderId: "ko_6527a1b2c3",
  merchantOrderId: "order_8841",
  status: "CAPTURED",
  method: "card",
  order: { amount: 250, currency: "EGP" },
  totalCapturedAmount: 250,
  totalRefundedAmount: 0,
  date: "2026-10-21T09:27:01.007Z",
  lastModifiedDate: "2026-10-21T09:46:07.381Z",
  transactions: [],
  ...over,
});

/** Stateful like the real sandbox: a refund raises the order's totalRefundedAmount. */
function routes(): MockRoute[] {
  let refunded = 0;
  return [
    {
      method: "GET",
      url: /\/v3\/payment\/orders/,
      respond: () => ({
        body: {
          status: "SUCCESS",
          data: [
            kashierOrder({ merchantOrderId: "order_88410" }),
            kashierOrder({ totalRefundedAmount: refunded }),
          ],
        },
      }),
    },
    {
      method: "PUT",
      url: /\/v3\/orders\/[^/]+$/,
      respond: (req) => {
        const amount =
          (req.json as { transaction?: { amount?: number } }).transaction?.amount ?? 250 - refunded;
        refunded += amount;
        return {
          body: {
            status: "SUCCESS",
            response: {
              result: "SUCCESS",
              status: "SUCCESS",
              transactionId: "TX-REF-1",
              amount,
              currency: "EGP",
            },
          },
        };
      },
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
    lookup: { reference: "order_8841" },
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

  it("supports lookups and refunds with a secret key, not without", () => {
    expect(kashier(options).capabilities).toMatchObject({
      getPayment: "supported",
      refund: "supported",
      partialRefund: "supported",
      cancel: "supported",
    });
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
  it("looks an order up by reference and picks the exact match from the partial search", async () => {
    const { sarraf, fetch } = setup();
    const p = await sarraf.payments.get({ provider: "kashier", reference: "order_8841" });
    expect(p).toMatchObject({
      status: "succeeded",
      providerPaymentId: "ko_6527a1b2c3",
      reference: "order_8841",
      amount: { value: 25000, currency: "EGP" },
      amountRefunded: { value: 0, currency: "EGP" },
      method: "card",
    });
    const url = fetch.calls[0]!.url;
    expect(url.origin + url.pathname).toBe("https://test-api.kashier.io/v3/payment/orders");
    expect(url.searchParams.get("search")).toBe("order_8841");
    expect(fetch.calls[0]!.headers.authorization).toBe("sec_1");
  });

  it("rejects lookups by Kashier's order id: the search only matches your reference", async () => {
    const { sarraf } = setup();
    await expect(
      sarraf.payments.get({ provider: "kashier", providerPaymentId: "ko_6527a1b2c3" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("reads the real sandbox order after a partial refund as partially_refunded", async () => {
    const f = loadFixture("kashier", "sandbox-order-partially-refunded");
    const exchange = (f as unknown as { exchanges: { responseBody: unknown }[] }).exchanges[0];
    const { sarraf } = setup({}, [
      { method: "GET", url: /orders/, respond: { body: exchange?.responseBody } },
    ]);
    const p = await sarraf.payments.get({ provider: "kashier", reference: "sarraf_fx_1792578275748" });
    expect(p).toMatchObject({
      status: "partially_refunded",
      providerPaymentId: "c61bcb59-8cac-4007-a8c7-9d5b5c9680f2",
      amount: { value: 1000, currency: "EGP" },
      amountRefunded: { value: 300, currency: "EGP" },
    });
  });

  it.each([
    ["CAPTURED", 250, "refunded"],
    ["REFUNDED", 0, "refunded"],
    ["PARTIALLY_REFUNDED", 0, "partially_refunded"],
    ["AUTHORIZED", 0, "requires_action"],
    ["INITIATED", 0, "pending"],
    ["FAILED", 0, "failed"],
    ["REJECTED", 0, "failed"],
    ["CANCELLED", 0, "canceled"],
    ["REVERSED", 0, "canceled"],
    ["EXPIRED", 0, "expired"],
  ])("maps order status %s (refunded %d) to %s", async (status, refunded, expected) => {
    const order = kashierOrder({
      status,
      totalRefundedAmount: refunded,
      transactions: [{ transactionResponseCode: "05", transactionResponseMessage: { en: "Do not honor" } }],
    });
    const { sarraf } = setup({}, [{ method: "GET", url: /orders/, respond: { body: { data: [order] } } }]);
    const p = await sarraf.payments.get({ provider: "kashier", reference: "order_8841" });
    expect(p.status).toBe(expected);
    if (expected === "failed") {
      expect(p.failure).toEqual({ code: "PAYMENT_DECLINED", message: "Do not honor", providerCode: "05" });
    }
  });

  it("falls back to captured / original amounts and defaults", async () => {
    const order = kashierOrder({
      order: undefined,
      totalCapturedAmount: undefined,
      originalAmount: "12.50",
      status: undefined,
    });
    const { sarraf } = setup({}, [{ method: "GET", url: /orders/, respond: { body: { data: [order] } } }]);
    const p = await sarraf.payments.get({ provider: "kashier", reference: "order_8841" });
    expect(p).toMatchObject({ status: "pending", amount: { value: 1250, currency: "EGP" } });
    const bare = setup({}, [
      {
        method: "GET",
        url: /orders/,
        respond: { body: { data: [{ merchantOrderId: "order_8841", status: "FAILED" }] } },
      },
    ]);
    const b = await bare.sarraf.payments.get({ provider: "kashier", reference: "order_8841" });
    expect(b).toMatchObject({
      status: "failed",
      providerPaymentId: "",
      failure: { message: "Payment failed" },
    });
  });

  it("reports NOT_FOUND and provider messages", async () => {
    const empty = setup({}, [{ method: "GET", url: /orders/, respond: { body: {} } }]);
    await expect(empty.sarraf.payments.get({ provider: "kashier", reference: "x" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const other = setup({}, [
      { method: "GET", url: /orders/, respond: { body: { data: [kashierOrder()] } } },
    ]);
    await expect(
      other.sarraf.payments.get({ provider: "kashier", reference: "order_884" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
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

  it("refunds the remaining amount, read from the order lookup", async () => {
    const { sarraf, fetch } = setup();
    const ref = { provider: "kashier" as const, providerPaymentId: "ko_6527a1b2c3", reference: "order_8841" };
    await sarraf.refunds.create({ ...ref, amount: { value: 5000, currency: "EGP" } });
    const refund = await sarraf.refunds.create(ref);
    // Kashier answers HTTP 500 to a refund without an amount, so the remainder is always sent.
    expect(fetch.calls.map((c) => c.method)).toEqual(["PUT", "GET", "PUT"]);
    expect(fetch.calls[2]!.json).toEqual({
      apiOperation: "REFUND",
      reason: "Refund",
      transaction: { amount: 200 },
    });
    expect(refund.amount).toEqual({ value: 20000, currency: "EGP" });
    await expect(sarraf.refunds.create(ref)).rejects.toThrow(/already fully refunded/);
  });

  it("explains what a full refund needs", async () => {
    const { sarraf } = setup();
    await expect(sarraf.refunds.create({ provider: "kashier", providerPaymentId: "ko_1" })).rejects.toThrow(
      /needs `reference`/,
    );
    await expect(
      sarraf.refunds.create({ provider: "kashier", providerPaymentId: "ko_other", reference: "order_8841" }),
    ).rejects.toThrow(/belongs to order ko_6527a1b2c3/);
  });

  it("reports pending / failed refunds", async () => {
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

  it("replays the real sandbox void: lookup, VOID of the pay transaction, lookup", async () => {
    const f = loadFixture("kashier", "sandbox-void-succeeded");
    const [before, put, after] = (f as unknown as { exchanges: { responseBody: unknown }[] }).exchanges;
    let lookups = 0;
    const { sarraf, fetch } = setup({}, [
      {
        method: "GET",
        url: /orders/,
        respond: () => ({ body: (lookups++ === 0 ? before : after)?.responseBody }),
      },
      { method: "PUT", url: /orders/, respond: { body: put?.responseBody } },
    ]);
    const p = await sarraf.payments.cancel({ provider: "kashier", reference: "sarraf_fx_1792580710302" });
    expect(fetch.calls.map((c) => c.method)).toEqual(["GET", "PUT", "GET"]);
    expect(fetch.calls[1]!.url.pathname).toBe("/v3/orders/0e8c7ec8-b167-4de5-9af2-9437fa1d775c");
    expect(fetch.calls[1]!.json).toEqual({
      apiOperation: "VOID",
      transaction: { targetTransactionId: "TX-3004573823", amount: 10 },
    });
    expect(p).toMatchObject({ status: "canceled", amount: { value: 1000, currency: "EGP" } });
  });

  it("refuses to void without a pay transaction, for another order, or when Kashier declines", async () => {
    const noPay = setup({}, [
      { method: "GET", url: /orders/, respond: { body: { data: [kashierOrder({ transactions: [] })] } } },
    ]);
    await expect(
      noPay.sarraf.payments.cancel({ provider: "kashier", reference: "order_8841" }),
    ).rejects.toThrow(/no successful pay to void/);
    const paid = kashierOrder({
      transactions: [
        { operation: "pay", status: "FAILURE", transactionId: "TX-1" },
        { operation: "pay", status: "SUCCESS", transactionId: "TX-2" },
      ],
    });
    const other = setup({}, [{ method: "GET", url: /orders/, respond: { body: { data: [paid] } } }]);
    await expect(
      other.sarraf.payments.cancel({
        provider: "kashier",
        reference: "order_8841",
        providerPaymentId: "ko_x",
      }),
    ).rejects.toThrow(/belongs to order ko_6527a1b2c3/);
    const declined = setup({}, [
      { method: "GET", url: /orders/, respond: { body: { data: [paid] } } },
      {
        method: "PUT",
        url: /orders/,
        respond: { body: { status: "FAILURE", response: { result: "FAILURE" } } },
      },
    ]);
    await expect(
      declined.sarraf.payments.cancel({ provider: "kashier", reference: "order_8841" }),
    ).rejects.toMatchObject({ code: "PAYMENT_DECLINED" });
    expect(declined.fetch.calls[1]!.json).toMatchObject({ transaction: { targetTransactionId: "TX-2" } });
    const noResult = setup({}, [
      { method: "GET", url: /orders/, respond: { body: { data: [paid] } } },
      { method: "PUT", url: /orders/, respond: { body: {} } },
    ]);
    await expect(
      noResult.sarraf.payments.cancel({ provider: "kashier", reference: "order_8841" }),
    ).rejects.toThrow(/no result/);
  });

  it("parses the real void webhook as payment canceled", async () => {
    const f = loadFixture("kashier", "sandbox-webhook-void");
    const { sarraf } = setup({ apiKey: f.secret! });
    const e = await sarraf.webhooks.verifyAndParse("kashier", f.webhook!);
    assertPaymentEvent(e);
    expect(e.type).toBe("payment.canceled");
    expect(e.payment).toMatchObject({ status: "canceled", reference: "sarraf_fx_1792580710302" });
  });

  it("refunds without allowBeta", async () => {
    const { sarraf } = setup({}, routes(), { allowBeta: false });
    const r = await sarraf.refunds.create({
      provider: "kashier",
      providerPaymentId: "ko_6527a1b2c3",
      amount: { value: 100, currency: "EGP" },
    });
    expect(r.status).toBe("succeeded");
  });

  it("replays the real sandbox full refund: lookup for the remainder, then refund 7.00", async () => {
    const f = loadFixture("kashier", "sandbox-refund-full-succeeded");
    const [lookup, put] = (f as unknown as { exchanges: { responseBody: unknown }[] }).exchanges;
    const { sarraf, fetch } = setup({}, [
      { method: "GET", url: /orders/, respond: { body: lookup?.responseBody } },
      { method: "PUT", url: /orders/, respond: { body: put?.responseBody } },
    ]);
    const r = await sarraf.refunds.create({
      provider: "kashier",
      providerPaymentId: "c61bcb59-8cac-4007-a8c7-9d5b5c9680f2",
      reference: "sarraf_fx_1792578275748",
    });
    expect(fetch.calls[1]!.json).toEqual({
      apiOperation: "REFUND",
      reason: "Refund",
      transaction: { amount: 7 },
    });
    expect(r).toMatchObject({
      status: "succeeded",
      amount: { value: 700, currency: "EGP" },
      providerRefundId: "TX-3004573807",
    });
  });

  it("replays the real full refund of a fresh order: nothing refunded before, refund 10.00", async () => {
    const f = loadFixture("kashier", "sandbox-refund-full-fresh-succeeded");
    const [lookup, put] = (f as unknown as { exchanges: { responseBody: unknown }[] }).exchanges;
    const { sarraf, fetch } = setup({}, [
      { method: "GET", url: /orders/, respond: { body: lookup?.responseBody } },
      { method: "PUT", url: /orders/, respond: { body: put?.responseBody } },
    ]);
    const r = await sarraf.refunds.create({
      provider: "kashier",
      providerPaymentId: "60713b61-70c8-42aa-a15a-38bd453f17fa",
      reference: "sarraf_fx_1792580708269",
    });
    expect(fetch.calls[1]!.json).toEqual({
      apiOperation: "REFUND",
      reason: "Refund",
      transaction: { amount: 10 },
    });
    expect(r).toMatchObject({ status: "succeeded", amount: { value: 1000, currency: "EGP" } });
  });

  it("parses the real full refund webhook as refunded, using the real order lookup", async () => {
    const f = loadFixture("kashier", "sandbox-webhook-refund-full");
    const order = loadFixture("kashier", "sandbox-order-refunded");
    const lookup = (order as unknown as { exchanges: { responseBody: unknown }[] }).exchanges[0];
    const { sarraf } = setup({ apiKey: f.secret! }, [
      { method: "GET", url: /orders/, respond: { body: lookup?.responseBody } },
    ]);
    const e = await sarraf.webhooks.verifyAndParse("kashier", f.webhook!);
    assertPaymentEvent(e);
    expect(e.type).toBe("refund.succeeded");
    expect(e.id).toBe("kashier:TX-3004573807:refund:refunded");
    expect(e.payment).toMatchObject({
      status: "refunded",
      amount: { value: 1000, currency: "EGP" },
      amountRefunded: { value: 1000, currency: "EGP" },
    });
  });
});

describe("kashier webhooks", () => {
  it("verifies recorded fixtures", async () => {
    for (const scenario of ["webhook-pay-success", "webhook-special-chars"]) {
      const f = loadFixture("kashier", scenario);
      const { sarraf } = setup({ apiKey: f.secret! });
      const e = await sarraf.webhooks.verifyAndParse("kashier", f.webhook!);
      assertPaymentEvent(e);
      expect(e.type).toBe("payment.succeeded");
    }
    const f = loadFixture("kashier", "webhook-refund-partial");
    // Refund events take their totals from the order lookup.
    const { sarraf } = setup({ apiKey: f.secret! }, [
      {
        method: "GET",
        url: /orders/,
        respond: { body: { data: [kashierOrder({ totalRefundedAmount: 100 })] } },
      },
    ]);
    const e = await sarraf.webhooks.verifyAndParse("kashier", f.webhook!);
    assertPaymentEvent(e);
    expect(e.type).toBe("refund.succeeded");
    expect(e.payment.status).toBe("partially_refunded");
    expect(e.payment.amountRefunded.value).toBe(10000);
    expect(e.payment.amount.value).toBe(25000);
    expect(e.id).toBe("kashier:TX-2491820499:refund:partially_refunded");
  });

  it("parses a real sandbox payment webhook and its redirect", async () => {
    const f = loadFixture("kashier", "sandbox-webhook-succeeded-1");
    const { sarraf } = setup({ apiKey: f.secret! });
    const e = await sarraf.webhooks.verifyAndParse("kashier", f.webhook!);
    assertPaymentEvent(e);
    expect(e.type).toBe("payment.succeeded");
    expect(e.id).toBe("kashier:TX-3004573804:succeeded");
    expect(e.payment).toMatchObject({
      status: "succeeded",
      reference: "sarraf_fx_1792578275748",
      amount: { value: 1000, currency: "EGP" },
      method: "card",
      card: { last4: "1111", brand: "Visa" },
    });

    const r = loadFixture("kashier", "sandbox-redirect-succeeded");
    const redirect = await sarraf.redirects.verify("kashier", r.query ?? {});
    expect(redirect).toMatchObject({
      authenticated: true,
      status: "succeeded",
      reference: "sarraf_fx_1792580708269",
    });
  });

  it("reports a real sandbox refund as succeeded although the order status is PARTIALLY_REFUNDED", async () => {
    const f = loadFixture<{ status: string }>("kashier", "sandbox-refund-partial-succeeded");
    const exchange = (f as unknown as { exchanges: { responseBody: unknown }[] }).exchanges[0];
    const { sarraf } = setup({}, [
      { method: "PUT", url: /orders/, respond: { body: exchange?.responseBody } },
    ]);
    const refund = await sarraf.refunds.create({
      provider: "kashier",
      providerPaymentId: "c61bcb59-8cac-4007-a8c7-9d5b5c9680f2",
      amount: { value: 300, currency: "EGP" },
    });
    expect(refund).toMatchObject({ status: "succeeded", providerRefundId: "TX-3004573805" });
  });

  // Kashier's refund webhook carries only the refund amount (3), not the order total (10). The
  // adapter reads the totals from the order lookup; both payloads are real sandbox recordings.
  it("parses a real partial refund webhook as partially_refunded, using the real order lookup", async () => {
    const f = loadFixture("kashier", "sandbox-webhook-refund-partial");
    const order = loadFixture("kashier", "sandbox-order-partially-refunded");
    const lookup = (order as unknown as { exchanges: { responseBody: unknown }[] }).exchanges[0];
    const { sarraf, fetch } = setup({ apiKey: f.secret! }, [
      { method: "GET", url: /orders/, respond: { body: lookup?.responseBody } },
    ]);
    const e = await sarraf.webhooks.verifyAndParse("kashier", f.webhook!);
    assertPaymentEvent(e);
    expect(fetch.calls[0]!.url.searchParams.get("search")).toBe("sarraf_fx_1792578275748");
    expect(e.type).toBe("refund.succeeded");
    expect(e.id).toBe("kashier:TX-3004573805:refund:partially_refunded");
    expect(e.payment).toMatchObject({
      status: "partially_refunded",
      amount: { value: 1000, currency: "EGP" },
      amountRefunded: { value: 300, currency: "EGP" },
      card: { last4: "1111", brand: "Visa" },
    });
  });

  it("warns and keeps the webhook's own view of a refund without a secret key", async () => {
    const f = loadFixture("kashier", "sandbox-webhook-refund-partial");
    const fetch = createMockFetch([]);
    const logger = { ...silentLogger, warn: vi.fn() };
    const sarraf = new Sarraf({
      providers: { kashier: kashier({ ...options, apiKey: f.secret!, secretKey: undefined }) },
      http: { fetch },
      logger,
    });
    const e = await sarraf.webhooks.verifyAndParse("kashier", f.webhook!);
    expect(e.type).toBe("refund.succeeded");
    expect(fetch.calls).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Configure secretKey"),
      expect.anything(),
    );
  });

  it("does not look the order up for a failed refund", async () => {
    const fetch = createMockFetch([]);
    const sarraf = new Sarraf({
      providers: { kashier: kashier(options) },
      http: { fetch },
      logger: silentLogger,
    });
    const e = await sarraf.webhooks.verifyAndParse(
      "kashier",
      signKashierWebhook("refund", kashierWebhookData({ status: "FAILURE" }), API_KEY),
    );
    assertPaymentEvent(e);
    expect(e.type).toBe("refund.failed");
    expect(fetch.calls).toHaveLength(0);
  });

  it("parses failures with messages and card details", async () => {
    const f = loadFixture("kashier", "webhook-pay-failed");
    const { sarraf } = setup({ apiKey: f.secret! });
    const e = await sarraf.webhooks.verifyAndParse("kashier", f.webhook!);
    assertPaymentEvent(e);
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
