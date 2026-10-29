import { assertPaymentEvent, isSarrafError, Sarraf, silentLogger } from "@sarraf/core";
import { runConformanceTests } from "@sarraf/core/conformance";
import { createMockFetch, type MockRoute } from "@sarraf/testing";
import { describe, expect, it } from "vitest";
import { type PaymobOptions, paymob } from "../src/index.js";
import { paymobTransaction, signPaymobCallback, signPaymobRedirect } from "../src/testing.js";

const HMAC = "test_hmac_secret";
const options: PaymobOptions = {
  region: "egypt",
  secretKey: "sk_test_abc",
  publicKey: "pk_test_abc",
  hmacSecret: HMAC,
  apiKey: "api_key_abc",
  integrationIds: { card: 123456, wallet: 654321 },
};

const BASE = "https://accept.paymob.com";

function routes(): MockRoute[] {
  return [
    {
      method: "POST",
      url: "/v1/intention/",
      respond: (req) => ({
        status: 201,
        body: {
          id: "pi_test_123",
          intention_order_id: 217503754,
          client_secret: "egy_csk_test_xyz",
          status: "intended",
          echo: req.json,
        },
      }),
    },
    { method: "POST", url: "/api/auth/tokens", respond: { status: 201, body: { token: "tok_1" } } },
    {
      method: "GET",
      url: /\/api\/acceptance\/transactions\/192036465/,
      respond: { body: paymobTransaction() },
    },
    {
      method: "POST",
      url: "/api/ecommerce/orders/transaction_inquiry",
      respond: { body: [paymobTransaction({ success: false }), paymobTransaction()] },
    },
    {
      method: "POST",
      url: "/api/acceptance/void_refund/refund",
      respond: (req) => ({
        body: paymobTransaction({
          id: 192036999,
          is_refund: true,
          amount_cents: (req.json as { amount_cents: number }).amount_cents,
        }),
      }),
    },
    {
      method: "POST",
      url: "/api/acceptance/void_refund/void",
      respond: { body: paymobTransaction({ id: 192037000, is_void: true }) },
    },
  ];
}

function setup(extra: Partial<PaymobOptions> = {}, r = routes()) {
  const fetch = createMockFetch(r);
  const sarraf = new Sarraf({
    providers: { paymob: paymob({ ...options, ...extra }) },
    http: { fetch, sleep: async () => {} },
    logger: silentLogger,
  });
  return { sarraf, fetch };
}

const checkoutInput = {
  provider: "paymob" as const,
  amount: { value: 25000, currency: "EGP" as const },
  reference: "order_8841",
  customer: { name: "Sara Ali Hassan", email: "sara@example.com", phone: "+201001234567" },
  returnUrl: "https://shop.example.com/thanks",
  webhookUrl: "https://shop.example.com/api/webhooks/paymob",
  methods: ["card" as const, "wallet" as const],
};

runConformanceTests("paymob", () => {
  const { sarraf, fetch } = setup();
  const succeeded = signPaymobCallback(paymobTransaction(), HMAC);
  const tamperedBody = (succeeded.rawBody as string).replace('"amount_cents":25000', '"amount_cents":1');
  return {
    sarraf,
    provider: "paymob",
    checkoutInput,
    expectedCheckoutKind: "redirect",
    webhooks: {
      succeeded,
      tampered: { ...succeeded, rawBody: tamperedBody },
      refunded: signPaymobCallback(
        paymobTransaction({ is_refunded: true, refunded_amount_cents: 25000 }),
        HMAC,
      ),
    },
    lookup: { providerPaymentId: "192036465" },
    refund: { providerPaymentId: "192036465", amount: { value: 10000, currency: "EGP" } },
    fetchCalls: () => fetch.calls.length,
  };
});

describe("paymob config", () => {
  it("validates options", () => {
    expect(() => paymob({ ...options, secretKey: "" })).toThrow(/secretKey is required/);
    expect(() => paymob({ ...options, integrationIds: {} })).toThrow(/at least one integration id/);
    expect(() => paymob({ ...options, publicKey: "pk_live_x" })).toThrow(
      /test key but publicKey is a live key/,
    );
  });

  it("resolves region base URL and currency", () => {
    const ksa = paymob({ ...options, region: "ksa" });
    expect(ksa.config.baseUrl).toBe("https://ksa.paymob.com");
    expect(ksa.capabilities.currencies).toEqual(["SAR"]);
    expect(paymob({ ...options, baseUrl: "https://proxy.test/" }).config.baseUrl).toBe("https://proxy.test");
    expect(paymob({ ...options, secretKey: "plain", publicKey: "plain" }).config.mode).toBe("test");
    expect(paymob({ ...options, secretKey: "sk_live_x", publicKey: "pk_live_x" }).config.mode).toBe("live");
    expect(paymob(options).publicKey).toBe("pk_test_abc");
  });

  it("marks getPayment unsupported without apiKey", () => {
    expect(paymob({ ...options, apiKey: undefined }).capabilities.getPayment).toBe("unsupported");
  });
});

describe("paymob checkout", () => {
  it("sends a correct intention and builds the unified checkout URL", async () => {
    const { sarraf, fetch } = setup();
    const checkout = await sarraf.checkout.create({
      ...checkoutInput,
      expiresInSeconds: 3600,
      metadata: { cart: "c1" },
    });
    const [call] = fetch.callsTo("POST", "/v1/intention/");
    expect(call!.headers.authorization).toBe("Token sk_test_abc");
    expect(call!.json).toEqual({
      amount: 25000,
      currency: "EGP",
      payment_methods: [123456, 654321],
      items: [{ name: "Order order_8841", amount: 25000, quantity: 1 }],
      billing_data: {
        first_name: "Sara",
        last_name: "Ali Hassan",
        email: "sara@example.com",
        phone_number: "+201001234567",
      },
      special_reference: "order_8841",
      notification_url: "https://shop.example.com/api/webhooks/paymob",
      redirection_url: "https://shop.example.com/thanks",
      expiration: 3600,
      extras: { cart: "c1", sarraf_ref: "order_8841" },
    });
    expect(checkout.redirectUrl).toBe(
      `${BASE}/unifiedcheckout/?publicKey=pk_test_abc&clientSecret=egy_csk_test_xyz`,
    );
    expect(checkout.id).toBe("paymob_pi_test_123");
    // The transaction id only exists once the customer pays; it arrives with the webhook.
    expect(checkout.payment.providerPaymentId).toBe("");
    expect(checkout.payment.status).toBe("pending");
    expect(checkout.expiresAt).toBeTruthy();
  });

  it("maps items, defaults names, and honors providerOptions", async () => {
    const { sarraf, fetch } = setup();
    await sarraf.checkout.create({
      ...checkoutInput,
      customer: { phone: "+201001234567" },
      methods: undefined,
      items: [{ name: "Mug", unitAmount: { value: 12500, currency: "EGP" }, quantity: 2 }],
      providerOptions: { paymentMethods: ["card"], extras: { x: 1 }, billingData: { city: "Cairo" } },
    });
    const body = fetch.calls[0]!.json as Record<string, unknown>;
    expect(body.items).toEqual([{ name: "Mug", amount: 12500, quantity: 2 }]);
    expect(body.payment_methods).toEqual(["card"]);
    expect(body.billing_data).toMatchObject({
      first_name: "NA",
      last_name: "NA",
      email: "NA",
      city: "Cairo",
    });
    expect(body.extras).toEqual({ sarraf_ref: "order_8841", x: 1 });
  });

  it("uses all integration ids when no methods are given", async () => {
    const { sarraf, fetch } = setup();
    await sarraf.checkout.create({ ...checkoutInput, methods: undefined });
    expect((fetch.calls[0]!.json as { payment_methods: number[] }).payment_methods).toEqual([123456, 654321]);
  });

  it("rejects methods without an integration id", async () => {
    const { sarraf } = setup({ integrationIds: { card: 1 } });
    await expect(sarraf.checkout.create(checkoutInput)).rejects.toMatchObject({
      code: "CAPABILITY_NOT_SUPPORTED",
    });
    const p = paymob({ ...options, integrationIds: { card: 1 } });
    const err = await p
      .createCheckout({ ...checkoutInput, methods: ["wallet"] }, setup().sarraf.ctx)
      .catch((e) => e);
    expect(err.message).toMatch(/no integration id configured for "wallet"/);
  });

  it("maps provider errors", async () => {
    const { sarraf } = setup({}, [
      { method: "POST", url: "/v1/intention/", respond: { status: 401, body: { detail: "Invalid token." } } },
    ]);
    await expect(sarraf.checkout.create(checkoutInput)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
      message: expect.stringContaining("Invalid token."),
    });
    const bad = setup({}, [
      { method: "POST", url: "/v1/intention/", respond: { status: 400, body: { amount: ["x"] } } },
    ]);
    await expect(bad.sarraf.checkout.create(checkoutInput)).rejects.toThrow(/amount/);
    const empty = setup({}, [
      { method: "POST", url: "/v1/intention/", respond: { status: 201, body: { id: "x" } } },
    ]);
    await expect(empty.sarraf.checkout.create(checkoutInput)).rejects.toThrow(/no client_secret/);
  });

  it("never retries a timed-out intention", async () => {
    let calls = 0;
    const sarraf = new Sarraf({
      providers: { paymob: paymob(options) },
      http: {
        timeoutMs: 5,
        fetch: (_u, init) =>
          new Promise((_r, reject) => {
            calls++;
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      },
      logger: silentLogger,
    });
    const err = await sarraf.checkout.create(checkoutInput).catch((e) => e);
    expect(isSarrafError(err, "TIMEOUT_UNKNOWN_OUTCOME")).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("paymob getPayment / refund / void", () => {
  it("caches the auth token and sends it as a Bearer header", async () => {
    const { sarraf, fetch } = setup();
    await sarraf.payments.get({ provider: "paymob", providerPaymentId: "192036465" });
    await sarraf.payments.get({ provider: "paymob", providerPaymentId: "192036465" });
    expect(fetch.callsTo("POST", "/api/auth/tokens")).toHaveLength(1);
    expect(fetch.calls[0]!.json).toEqual({ api_key: "api_key_abc" });
    expect(fetch.calls[1]!.headers.authorization).toBe("Bearer tok_1");
    expect(fetch.calls[1]!.url.searchParams.get("token")).toBeNull();
  });

  it("refreshes the token after expiry and on 401", async () => {
    let now = 0;
    const r = routes();
    let fail = true;
    r.unshift({
      method: "GET",
      url: /transactions\/1$/,
      respond: () => {
        if (fail) {
          fail = false;
          return { status: 401, body: { detail: "expired" } };
        }
        return { body: paymobTransaction({ id: 1 }) };
      },
    });
    const fetch = createMockFetch(r);
    const sarraf = new Sarraf({
      providers: { paymob: paymob(options) },
      http: { fetch },
      logger: silentLogger,
      now: () => new Date(now),
    });
    // A 401 drops the cached token and retries once with a fresh one.
    const p = await sarraf.payments.get({ provider: "paymob", providerPaymentId: "1" });
    expect(p.providerPaymentId).toBe("1");
    expect(fetch.callsTo("POST", "/api/auth/tokens")).toHaveLength(2);
    now = 51 * 60 * 1000;
    await sarraf.payments.get({ provider: "paymob", providerPaymentId: "192036465" });
    expect(fetch.callsTo("POST", "/api/auth/tokens")).toHaveLength(3);
  });

  it("looks up by reference using the latest transaction", async () => {
    const { sarraf, fetch } = setup();
    const p = await sarraf.payments.reconcile({ provider: "paymob", reference: "order_8841" });
    expect(p.status).toBe("succeeded");
    const [inquiry] = fetch.callsTo("POST", "/api/ecommerce/orders/transaction_inquiry");
    expect(inquiry!.json).toEqual({ auth_token: "tok_1", merchant_order_id: "order_8841" });
    expect(inquiry!.headers.authorization).toBe("Bearer tok_1");
  });

  it("reports NOT_FOUND for an empty inquiry and auth errors", async () => {
    const { sarraf } = setup({}, [
      { method: "POST", url: "/api/auth/tokens", respond: { body: { token: "t" } } },
      { method: "POST", url: "/api/ecommerce/orders/transaction_inquiry", respond: { body: [] } },
    ]);
    await expect(sarraf.payments.get({ provider: "paymob", reference: "x" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const noToken = setup({}, [{ method: "POST", url: "/api/auth/tokens", respond: { body: {} } }]);
    await expect(noToken.sarraf.payments.get({ provider: "paymob", providerPaymentId: "1" })).rejects.toThrow(
      /no token/,
    );
    const p = paymob({ ...options, apiKey: undefined });
    await expect(p.getPayment({ providerPaymentId: "1" }, setup().sarraf.ctx)).rejects.toThrow(
      /apiKey is required/,
    );
  });

  it("refunds a partial amount", async () => {
    const { sarraf, fetch } = setup();
    const refund = await sarraf.refunds.create({
      provider: "paymob",
      providerPaymentId: "192036465",
      amount: { value: 10000, currency: "EGP" },
    });
    expect(fetch.calls[0]!.json).toEqual({ transaction_id: 192036465, amount_cents: 10000 });
    expect(fetch.calls[0]!.headers.authorization).toBe("Token sk_test_abc");
    expect(refund).toMatchObject({
      status: "succeeded",
      providerRefundId: "192036999",
      amount: { value: 10000 },
    });
  });

  it("refunds the remaining amount when no amount is given", async () => {
    const r = routes();
    r.unshift({
      method: "GET",
      url: /transactions\/192036465/,
      respond: { body: paymobTransaction({ is_refunded: true, refunded_amount_cents: 5000 }) },
    });
    const { sarraf, fetch } = setup({}, r);
    const refund = await sarraf.refunds.create({ provider: "paymob", providerPaymentId: "192036465" });
    expect(fetch.callsTo("POST", "/api/acceptance/void_refund/refund")[0]!.json).toMatchObject({
      amount_cents: 20000,
    });
    expect(refund.amount).toEqual({ value: 20000, currency: "EGP" });
  });

  it("refuses to refund a fully refunded payment, and reports pending/failed refunds", async () => {
    const r = routes();
    r.unshift({
      method: "GET",
      url: /transactions\/192036465/,
      respond: { body: paymobTransaction({ is_refunded: true, refunded_amount_cents: 25000 }) },
    });
    await expect(
      setup({}, r).sarraf.refunds.create({ provider: "paymob", providerPaymentId: "192036465" }),
    ).rejects.toThrow(/nothing left/);
    const pending = setup({}, [
      { url: "/api/acceptance/void_refund/refund", respond: { body: { pending: true } } },
    ]);
    const p = await pending.sarraf.refunds.create({
      provider: "paymob",
      providerPaymentId: "1",
      amount: { value: 1, currency: "EGP" },
    });
    expect(p.status).toBe("pending");
    expect(p.id).toBe("paymob_refund_1");
    const failed = setup({}, [
      { url: "/api/acceptance/void_refund/refund", respond: { body: { id: 9, success: false } } },
    ]);
    expect(
      (
        await failed.sarraf.refunds.create({
          provider: "paymob",
          providerPaymentId: "1",
          amount: { value: 1, currency: "EGP" },
        })
      ).status,
    ).toBe("failed");
    await expect(
      setup().sarraf.refunds.create({
        provider: "paymob",
        providerPaymentId: "abc",
        amount: { value: 1, currency: "EGP" },
      }),
    ).rejects.toThrow(/must be numeric/);
  });

  it("voids", async () => {
    const { sarraf, fetch } = setup();
    const p = await sarraf.payments.cancel({ provider: "paymob", providerPaymentId: "192036465" });
    expect(fetch.calls[0]!.json).toEqual({ transaction_id: 192036465 });
    expect(p.status).toBe("canceled");
    expect(p.providerPaymentId).toBe("192036465");
    // By reference: the transaction id comes from the inquiry first.
    const byRef = setup();
    const v = await byRef.sarraf.payments.cancel({ provider: "paymob", reference: "order_8841" });
    expect(v.providerPaymentId).toBe("192036465");
    expect(byRef.fetch.callsTo("POST", "/api/acceptance/void_refund/void")[0]!.json).toEqual({
      transaction_id: 192036465,
    });
    const failed = setup({}, [
      {
        url: "/api/acceptance/void_refund/void",
        respond: { body: paymobTransaction({ id: 5, success: false, data: { message: "Not same day" } }) },
      },
    ]);
    await expect(
      failed.sarraf.payments.cancel({ provider: "paymob", providerPaymentId: "1" }),
    ).rejects.toMatchObject({ code: "PAYMENT_DECLINED", message: expect.stringMatching(/Not same day/) });
  });
});

describe("paymob webhooks", () => {
  it("parses declined and refund transactions", async () => {
    const { sarraf } = setup();
    const declined = await sarraf.webhooks.verifyAndParse(
      "paymob",
      signPaymobCallback(paymobTransaction({ success: false }), HMAC),
    );
    expect(declined.type).toBe("payment.failed");
    const refund = await sarraf.webhooks.verifyAndParse(
      "paymob",
      signPaymobCallback(paymobTransaction({ id: 7, is_refund: true, success: true }), HMAC),
    );
    expect(refund.type).toBe("refund.succeeded");
    const refundFailed = await sarraf.webhooks.verifyAndParse(
      "paymob",
      signPaymobCallback(paymobTransaction({ id: 8, is_refund: true, success: false }), HMAC),
    );
    expect(refundFailed.type).toBe("refund.failed");
  });

  it("explains rejections", async () => {
    const { sarraf } = setup();
    const ok = signPaymobCallback(paymobTransaction(), HMAC);
    expect((await sarraf.webhooks.inspect("paymob", { ...ok, query: {} })).reason).toMatch(/missing `hmac`/);
    expect((await sarraf.webhooks.inspect("paymob", { ...ok, rawBody: "{" })).reason).toMatch(
      /not valid JSON/,
    );
    expect(
      (
        await sarraf.webhooks.inspect("paymob", {
          ...ok,
          rawBody: JSON.stringify({ type: "SUBSCRIPTION", obj: { id: 1 } }),
        })
      ).reason,
    ).toMatch(/callback type "SUBSCRIPTION" is not supported/);
    expect((await sarraf.webhooks.inspect("paymob", { ...ok, rawBody: "{}" })).reason).toMatch(
      /obj is missing/,
    );
    await expect(sarraf.webhooks.verifyAndParse("paymob", { ...ok, query: { hmac: "00" } })).rejects.toThrow(
      /HMAC mismatch/,
    );
    const asBuffer = await sarraf.webhooks.verifyAndParse("paymob", {
      ...ok,
      rawBody: new TextEncoder().encode(ok.rawBody as string),
    });
    assertPaymentEvent(asBuffer);
    expect(asBuffer.payment.status).toBe("succeeded");
  });
});

describe("paymob redirect", () => {
  const base = {
    id: "192036465",
    success: "true",
    pending: "false",
    amount_cents: "25000",
    merchant_order_id: "order_8841",
    is_voided: "false",
    is_refunded: "false",
  };

  it("is unauthenticated without a valid hmac, but still reports status for UX", async () => {
    const { sarraf } = setup();
    const r = await sarraf.redirects.verify("paymob", base);
    expect(r).toMatchObject({
      authenticated: false,
      status: "succeeded",
      reference: "order_8841",
      providerPaymentId: "192036465",
    });
    expect((await sarraf.redirects.verify("paymob", { a: "1" })).status).toBe("unknown");
  });

  it("authenticates a signed redirect", async () => {
    const { sarraf } = setup();
    const r = await sarraf.redirects.verify("paymob", signPaymobRedirect(base, HMAC));
    expect(r.authenticated).toBe(true);
    expect(
      (await sarraf.redirects.verify("paymob", { ...signPaymobRedirect(base, HMAC), success: "false" }))
        .authenticated,
    ).toBe(false);
  });
});
