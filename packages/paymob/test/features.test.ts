import { assertPaymentEvent, type CardSavedEvent, Sarraf, silentLogger } from "@sarrafjs/core";
import { createMockFetch, type MockRoute } from "@sarrafjs/testing";
import { describe, expect, it } from "vitest";
import { type PaymobOptions, paymob, paymobEmbed } from "../src/index.js";
import {
  paymobCardToken,
  paymobTransaction,
  signPaymobCallback,
  signPaymobSubscriptionCallback,
  signPaymobTokenCallback,
} from "../src/testing.js";

const HMAC = "test_hmac_secret";
const options: PaymobOptions = {
  secretKey: "sk_test_abc",
  publicKey: "pk_test_abc",
  hmacSecret: HMAC,
  apiKey: "api_key_abc",
  integrationIds: { card: 11, wallet: 22, cash_outlet: 33, card_auth: 44, card_moto: 55, apple_pay: 66 },
};

const intention = (keys: { integration: number; key: string }[] = []) => ({
  status: 201,
  body: {
    id: "pi_test_1",
    intention_order_id: 900,
    client_secret: "egy_csk_test_1",
    payment_keys: keys,
  },
});

function setup(
  r: MockRoute[],
  extra: Partial<PaymobOptions> = {},
  sarrafOptions: { allowBeta?: boolean } = {},
) {
  const fetch = createMockFetch([
    { method: "POST", url: "/api/auth/tokens", respond: { status: 201, body: { token: "tok_1" } } },
    ...r,
  ]);
  const sarraf = new Sarraf({
    providers: { paymob: paymob({ ...options, ...extra }) },
    http: { fetch, sleep: async () => {} },
    logger: silentLogger,
    allowBeta: sarrafOptions.allowBeta ?? true,
  });
  return { sarraf, fetch, extras: sarraf.provider("paymob").extras };
}

const customer = { name: "Sara Ali", email: "sara@example.com", phone: "+201001234567" };
const amount = { value: 25000, currency: "EGP" as const };

describe("paymob capabilities", () => {
  it("marks verified methods supported and new features beta", () => {
    const caps = paymob(options).capabilities;
    expect(caps.methods).toEqual({ card: "supported", wallet: "supported", cash_outlet: "beta" });
    expect(caps.capture).toBe("beta");
    expect(caps.checkoutKinds).toEqual(["redirect", "reference_code"]);
    const minimal = paymob({ ...options, apiKey: undefined, integrationIds: { card: 1 } }).capabilities;
    expect(minimal).toMatchObject({
      capture: "unsupported",
      getPayment: "unsupported",
      checkoutKinds: ["redirect"],
    });
  });

  it("requires allowBeta for capture", async () => {
    const { sarraf } = setup([], {}, { allowBeta: false });
    await expect(
      sarraf.payments.capture({ provider: "paymob", providerPaymentId: "1", amount }),
    ).rejects.toMatchObject({ code: "CAPABILITY_NOT_SUPPORTED", message: expect.stringMatching(/beta/) });
  });
});

describe("paymob checkout options", () => {
  it("offers Apple Pay with card and skips auth / MOTO / kiosk by default", async () => {
    const { sarraf, fetch } = setup([{ method: "POST", url: "/v1/intention/", respond: intention() }]);
    await sarraf.checkout.create({ provider: "paymob", amount, reference: "r1", customer });
    await sarraf.checkout.create({
      provider: "paymob",
      amount,
      reference: "r2",
      customer,
      methods: ["card"],
    });
    const [all, card] = fetch.callsTo("POST", "/v1/intention/");
    expect((all!.json as { payment_methods: number[] }).payment_methods).toEqual([11, 22, 66]);
    expect((card!.json as { payment_methods: number[] }).payment_methods).toEqual([11, 66]);
  });

  it("authorizes on the auth integration for manual capture, card only", async () => {
    const { sarraf, fetch } = setup([{ method: "POST", url: "/v1/intention/", respond: intention() }]);
    await sarraf.checkout.create({
      provider: "paymob",
      amount,
      reference: "r1",
      customer,
      providerOptions: { capture: "manual" },
    });
    expect((fetch.calls[0]!.json as { payment_methods: number[] }).payment_methods).toEqual([44]);
    await expect(
      sarraf.checkout.create({
        provider: "paymob",
        amount,
        reference: "r2",
        customer,
        methods: ["wallet"],
        providerOptions: { capture: "manual" },
      }),
    ).rejects.toThrow(/card payments only/);
  });

  it("passes saved card tokens and subscription fields", async () => {
    const { sarraf, fetch, extras } = setup([
      { method: "POST", url: "/v1/intention/", respond: intention() },
    ]);
    await sarraf.checkout.create({
      provider: "paymob",
      amount,
      reference: "r1",
      customer,
      providerOptions: { cardTokens: ["tok_card"] },
    });
    await extras.subscriptions.create({
      planId: 7,
      startDate: "2026-11-01",
      amount,
      reference: "r2",
      customer,
    });
    await extras.subscriptions.cards.add(31, { amount, reference: "r3", customer });
    const [saved, sub, addCard] = fetch
      .callsTo("POST", "/v1/intention/")
      .map((c) => c.json as Record<string, unknown>);
    expect(saved!.card_tokens).toEqual(["tok_card"]);
    expect(sub).toMatchObject({
      subscription_plan_id: 7,
      subscription_start_date: "2026-11-01",
      payment_methods: [11, 66],
    });
    expect(addCard).toMatchObject({ subscriptionv2_id: 31 });
  });

  it("exposes Pixel parameters", async () => {
    const { sarraf } = setup([{ method: "POST", url: "/v1/intention/", respond: intention() }]);
    const checkout = await sarraf.checkout.create({ provider: "paymob", amount, reference: "r1", customer });
    expect(paymobEmbed(checkout)).toEqual({ publicKey: "pk_test_abc", clientSecret: "egy_csk_test_1" });
  });
});

describe("paymob kiosk", () => {
  it("returns the bill reference as a reference_code checkout", async () => {
    const { sarraf, fetch } = setup([
      {
        method: "POST",
        url: "/v1/intention/",
        respond: intention([
          { integration: 11, key: "pk_card" },
          { integration: 33, key: "pk_kiosk" },
        ]),
      },
      {
        method: "POST",
        url: "/api/acceptance/payments/pay",
        respond: {
          body: paymobTransaction({
            id: 777,
            pending: true,
            success: false,
            source_data: { type: "aggregator", sub_type: "AGGREGATOR" },
            data: { bill_reference: 1234567, message: "Pending" },
          }),
        },
      },
    ]);
    const checkout = await sarraf.checkout.create({
      provider: "paymob",
      amount,
      reference: "order_8841",
      customer,
      methods: ["cash_outlet"],
    });
    expect((fetch.calls[0]!.json as { payment_methods: number[] }).payment_methods).toEqual([33]);
    expect(fetch.callsTo("POST", "/api/acceptance/payments/pay")[0]!.json).toEqual({
      source: { identifier: "AGGREGATOR", subtype: "AGGREGATOR" },
      payment_token: "pk_kiosk",
    });
    expect(checkout).toMatchObject({ kind: "reference_code", referenceCode: "1234567" });
    expect(checkout.payment).toMatchObject({
      status: "awaiting_payment",
      providerPaymentId: "777",
      method: "cash_outlet",
      reference: "order_8841",
    });
  });

  it("cannot be combined with other methods, and is not refundable", async () => {
    const { sarraf } = setup([
      {
        method: "GET",
        url: /transactions\/777$/,
        respond: { body: paymobTransaction({ id: 777, source_data: { type: "aggregator" } }) },
      },
    ]);
    await expect(
      sarraf.checkout.create({
        provider: "paymob",
        amount,
        reference: "r",
        customer,
        methods: ["cash_outlet", "card"],
      }),
    ).rejects.toThrow(/cannot be combined/);
    await expect(sarraf.refunds.create({ provider: "paymob", providerPaymentId: "777" })).rejects.toThrow(
      /kiosk payments cannot be refunded/,
    );
  });
});

describe("paymob capture", () => {
  const routes: MockRoute[] = [
    {
      method: "GET",
      url: /transactions\/500$/,
      respond: { body: paymobTransaction({ id: 500, is_auth: true, is_capture: false }) },
    },
    {
      method: "POST",
      url: "/api/acceptance/capture",
      respond: (req) => ({
        body: paymobTransaction({
          id: 501,
          is_capture: true,
          parent_transaction: 500,
          amount_cents: (req.json as { amount_cents: number }).amount_cents,
        }),
      }),
    },
  ];

  it("maps an authorization to requires_action", async () => {
    const { sarraf } = setup(routes);
    const auth = await sarraf.payments.get({ provider: "paymob", providerPaymentId: "500" });
    expect(auth.status).toBe("requires_action");
  });

  it("captures the full authorization or a partial amount", async () => {
    const { sarraf, fetch } = setup(routes);
    const full = await sarraf.payments.capture({ provider: "paymob", providerPaymentId: "500" });
    const partial = await sarraf.payments.capture({
      provider: "paymob",
      providerPaymentId: "500",
      amount: { value: 10000, currency: "EGP" },
    });
    const calls = fetch.callsTo("POST", "/api/acceptance/capture");
    expect(calls.map((c) => c.json)).toEqual([
      { transaction_id: 500, amount_cents: 25000 },
      { transaction_id: 500, amount_cents: 10000 },
    ]);
    expect(calls[0]!.headers.authorization).toBe("Token sk_test_abc");
    expect(full).toMatchObject({ status: "succeeded", providerPaymentId: "500", id: "paymob_500" });
    expect(partial.amount.value).toBe(10000);
  });

  it("throws when Paymob declines, and needs an amount without apiKey", async () => {
    const { sarraf } = setup([
      {
        method: "POST",
        url: "/api/acceptance/capture",
        respond: {
          body: paymobTransaction({
            success: false,
            data: { message: "Capture amount cannot exceed auth amount" },
          }),
        },
      },
    ]);
    await expect(
      sarraf.payments.capture({ provider: "paymob", providerPaymentId: "500", amount }),
    ).rejects.toMatchObject({ code: "PAYMENT_DECLINED", message: expect.stringMatching(/cannot exceed/) });
    const noKey = setup([], { apiKey: undefined });
    await expect(
      noKey.sarraf.payments.capture({ provider: "paymob", providerPaymentId: "500" }),
    ).rejects.toThrow(/pass `amount`/);
  });
});

describe("paymob refunds", () => {
  it("returns the payment with its new totals", async () => {
    const { sarraf } = setup([
      {
        method: "POST",
        url: "/api/acceptance/void_refund/refund",
        respond: {
          body: paymobTransaction({ id: 9, is_refund: true, amount_cents: 10000, parent_transaction: 1 }),
        },
      },
      {
        method: "GET",
        url: /transactions\/1$/,
        respond: { body: paymobTransaction({ id: 1, is_refunded: true, refunded_amount_cents: 10000 }) },
      },
    ]);
    const refund = await sarraf.refunds.create({
      provider: "paymob",
      providerPaymentId: "1",
      amount: { value: 10000, currency: "EGP" },
    });
    expect(refund.status).toBe("succeeded");
    expect(refund.payment).toMatchObject({ status: "partially_refunded", amountRefunded: { value: 10000 } });
  });

  it("explains that a full refund needs apiKey", async () => {
    const { sarraf } = setup([], { apiKey: undefined });
    await expect(sarraf.refunds.create({ provider: "paymob", providerPaymentId: "1" })).rejects.toMatchObject(
      {
        code: "CONFIGURATION_INVALID",
        message: expect.stringMatching(/pass `amount`/),
      },
    );
  });
});

describe("paymob callbacks", () => {
  it("reports the refunded payment's totals on a refund callback", async () => {
    const { sarraf } = setup([
      {
        method: "GET",
        url: /transactions\/192036465$/,
        respond: { body: paymobTransaction({ is_refunded: true, refunded_amount_cents: 10000 }) },
      },
    ]);
    const event = await sarraf.webhooks.verifyAndParse(
      "paymob",
      signPaymobCallback(
        paymobTransaction({ id: 9, is_refund: true, amount_cents: 10000, parent_transaction: 192036465 }),
        HMAC,
      ),
    );
    assertPaymentEvent(event);
    expect(event.type).toBe("refund.succeeded");
    expect(event.id).toBe("paymob:9:partially_refunded");
    expect(event.payment).toMatchObject({
      providerPaymentId: "192036465",
      status: "partially_refunded",
      amount: { value: 25000 },
      amountRefunded: { value: 10000 },
    });
  });

  it("falls back to the refund transaction without apiKey or when the lookup fails", async () => {
    const callback = signPaymobCallback(
      paymobTransaction({ id: 9, is_refund: true, amount_cents: 10000, parent_transaction: 1 }),
      HMAC,
    );
    for (const s of [
      setup([], { apiKey: undefined }),
      setup([{ method: "GET", url: /transactions\/1$/, respond: { status: 500 } }]),
    ]) {
      const event = await s.sarraf.webhooks.verifyAndParse("paymob", callback);
      assertPaymentEvent(event);
      expect(event.payment).toMatchObject({ providerPaymentId: "9", status: "refunded" });
    }
  });

  it("turns a TOKEN callback into card.saved", async () => {
    const { sarraf } = setup([]);
    const req = signPaymobTokenCallback(paymobCardToken(), HMAC);
    const inspection = await sarraf.webhooks.inspect("paymob", req);
    expect(inspection).toMatchObject({ valid: true, algorithm: expect.stringMatching(/card-token/) });
    expect(inspection.signedString).toBe(
      "MasterCard2026-10-20T13:37:05.226145customer@example.com1873xxxx-xxxx-xxxx-2346302852217503754e5ad4f6e0e9a40c4b5a1b8f0d27a2c51",
    );
    const event = (await sarraf.webhooks.verifyAndParse("paymob", req)) as CardSavedEvent;
    expect(event).toMatchObject({
      id: "paymob:1873:card.saved",
      type: "card.saved",
      providerOrderId: "217503754",
      card: {
        token: "e5ad4f6e0e9a40c4b5a1b8f0d27a2c51",
        last4: "2346",
        brand: "MasterCard",
        expiryMonth: "01",
        expiryYear: "39",
        holderName: "Test Account",
      },
    });
    const tampered = { ...req, rawBody: (req.rawBody as string).replace("2346", "9999") };
    await expect(sarraf.webhooks.verifyAndParse("paymob", tampered)).rejects.toMatchObject({
      code: "WEBHOOK_SIGNATURE_INVALID",
    });
  });
});

describe("paymob extras", () => {
  it("needs the adapter registered with Sarraf", async () => {
    await expect(paymob(options).extras.cards.listForOrder(1)).rejects.toThrow(/registered with new Sarraf/);
  });

  it("charges a saved card on the MOTO integration, once per idempotency key", async () => {
    const { fetch, extras } = setup([
      { method: "POST", url: "/v1/intention/", respond: intention([{ integration: 55, key: "pk_moto" }]) },
      {
        method: "POST",
        url: "/api/acceptance/payments/pay",
        respond: { body: paymobTransaction({ id: 321, order: { id: 900, merchant_order_id: null } }) },
      },
    ]);
    const input = { token: "tok_card", reference: "renewal_1", amount, customer, idempotencyKey: "k1" };
    const payment = await extras.cards.charge(input);
    const again = await extras.cards.charge(input);
    expect(again).toEqual(payment);
    expect(fetch.callsTo("POST", "/api/acceptance/payments/pay")).toHaveLength(1);
    expect(
      (fetch.callsTo("POST", "/v1/intention/")[0]!.json as { payment_methods: number[] }).payment_methods,
    ).toEqual([55]);
    expect(fetch.callsTo("POST", "/api/acceptance/payments/pay")[0]!.json).toEqual({
      source: { identifier: "tok_card", subtype: "TOKEN" },
      payment_token: "pk_moto",
    });
    expect(payment).toMatchObject({ status: "succeeded", providerPaymentId: "321", reference: "renewal_1" });
    await expect(
      extras.cards.charge({ ...input, amount: { value: 0, currency: "EGP" } }),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });

  it("lists the cards saved on an order", async () => {
    const { fetch, extras } = setup([
      {
        method: "POST",
        url: "/api/acceptance/order_card_tokens",
        respond: {
          body: [
            { type: "TOKEN", obj: paymobCardToken() },
            { type: "TOKEN", obj: {} },
          ],
        },
      },
    ]);
    const cards = await extras.cards.listForOrder("217503754");
    expect(cards).toEqual([
      expect.objectContaining({ token: "e5ad4f6e0e9a40c4b5a1b8f0d27a2c51", last4: "2346" }),
    ]);
    expect(fetch.callsTo("POST", "/api/acceptance/order_card_tokens")[0]!.json).toEqual({
      auth_token: "tok_1",
      order_id: 217503754,
    });
  });

  it("updates and retrieves an intention", async () => {
    const { sarraf, fetch, extras } = setup([
      { method: "POST", url: "/v1/intention/", respond: intention() },
      { method: "PUT", url: "/v1/intention/egy_csk_test_1/", respond: intention() },
      { method: "GET", url: "/v1/intention/element/pk_test_abc/egy_csk_test_1/", respond: intention() },
    ]);
    const checkout = await sarraf.checkout.create({ provider: "paymob", amount, reference: "r1", customer });
    await extras.intentions.update(checkout, { amount: 30000 });
    await extras.intentions.retrieve(checkout);
    const [put] = fetch.callsTo("PUT", "/v1/intention/egy_csk_test_1/");
    expect(put!.json).toEqual({ amount: 30000, accept_order_id: 900 });
    expect(put!.headers.authorization).toBe("Token sk_test_abc");
    expect(
      fetch.callsTo("GET", "/v1/intention/element/pk_test_abc/egy_csk_test_1/")[0]!.headers.authorization,
    ).toBeUndefined();
  });

  it("manages subscription plans and subscriptions", async () => {
    const { fetch, extras } = setup([
      {
        method: "POST",
        url: "/api/acceptance/subscription-plans",
        respond: { status: 201, body: { id: 12 } },
      },
      {
        method: "GET",
        url: "/api/acceptance/subscription-plans",
        respond: { body: { results: [{ id: 12 }] } },
      },
      { method: "PUT", url: "/api/acceptance/subscription-plans/12", respond: { body: { id: 12 } } },
      { method: "POST", url: /subscription-plans\/12\/suspend$/, respond: { body: { id: 12 } } },
      { method: "POST", url: /subscriptions\/31\/(suspend|resume|cancel)$/, respond: { body: { id: 31 } } },
      { method: "PUT", url: "/api/acceptance/subscriptions/31", respond: { body: { id: 31 } } },
      { method: "GET", url: /subscriptions\?/, respond: { body: [{ id: 31 }] } },
      {
        method: "GET",
        url: /subscriptions\/31\/last-transaction$/,
        respond: { body: paymobTransaction({ id: 600 }) },
      },
      {
        method: "GET",
        url: /subscriptions\/31\/card-tokens$/,
        respond: { body: [paymobCardToken()] },
      },
      { method: "POST", url: /subscriptions\/31\/change-primary-card$/, respond: { body: { id: 31 } } },
    ]);
    const plan = await extras.subscriptions.plans.create({ name: "Monthly", frequency: 30, amount });
    expect(plan.id).toBe(12);
    expect(fetch.callsTo("POST", "/api/acceptance/subscription-plans")[0]!.json).toEqual({
      name: "Monthly",
      frequency: 30,
      amount_cents: 25000,
      integration: 55,
      is_active: true,
    });
    await expect(extras.subscriptions.plans.create({ name: "x", frequency: 31, amount })).rejects.toThrow(
      /frequency must be one of/,
    );
    expect(await extras.subscriptions.plans.list()).toEqual([{ id: 12 }]);
    await extras.subscriptions.plans.update(12, { amount: { value: 30000, currency: "EGP" } });
    expect(fetch.callsTo("PUT", "/api/acceptance/subscription-plans/12")[0]!.json).toEqual({
      amount_cents: 30000,
    });
    await extras.subscriptions.plans.suspend(12);

    expect(await extras.subscriptions.list({ plan_id: 12 })).toEqual([{ id: 31 }]);
    expect(fetch.callsTo("GET", /subscriptions\?/)[0]!.url.searchParams.get("plan_id")).toBe("12");
    await extras.subscriptions.update(31, { nextBilling: "2026-12-01" });
    expect(fetch.callsTo("PUT", "/api/acceptance/subscriptions/31")[0]!.json).toEqual({
      next_billing: "2026-12-01",
    });
    for (const action of ["suspend", "resume", "cancel"] as const) await extras.subscriptions[action](31);
    expect(fetch.callsTo("POST", /subscriptions\/31\/(suspend|resume|cancel)$/)).toHaveLength(3);
    expect((await extras.subscriptions.lastTransaction(31)).providerPaymentId).toBe("600");
    expect(await extras.subscriptions.cards.list(31)).toHaveLength(1);
    await extras.subscriptions.cards.setPrimary(31, 1873);
    expect(fetch.callsTo("POST", /change-primary-card$/)[0]!.json).toEqual({ card: 1873 });
    for (const call of fetch.calls.filter((c) => !c.url.pathname.includes("auth/tokens"))) {
      expect(call.headers.authorization).toBe("Bearer tok_1");
    }
  });

  it("verifies subscription callbacks", () => {
    const { extras } = setup([]);
    const body = {
      paymob_request_id: "req_1",
      trigger_type: "suspended",
      subscription_data: { id: 1264, plan_id: 12, state: "suspended" },
    };
    const req = signPaymobSubscriptionCallback(body, HMAC);
    expect(extras.subscriptions.inspectWebhook(req)).toMatchObject({
      valid: true,
      signedString: "suspendedfor1264",
    });
    expect(extras.subscriptions.verifyWebhook(req)).toMatchObject({
      id: "paymob:subscription:1264:suspended:req_1",
      trigger: "suspended",
      subscriptionId: 1264,
      subscription: { state: "suspended" },
    });
    const tampered = { ...req, rawBody: (req.rawBody as string).replace("1264", "1265") };
    expect(() => extras.subscriptions.verifyWebhook(tampered)).toThrow(/HMAC mismatch/);
    expect(extras.subscriptions.inspectWebhook({ rawBody: "{}" }).reason).toMatch(
      /not a subscription callback/,
    );
  });

  it("creates and cancels payment links", async () => {
    const { fetch, extras } = setup([
      {
        method: "POST",
        url: "/api/ecommerce/payment-links",
        respond: {
          status: 201,
          body: {
            id: 88,
            client_url: "https://accept.paymob.com/standalone/?ref=abc",
            shorten_url: "https://pmob.me/abc",
            state: "created",
          },
        },
      },
      {
        method: "POST",
        url: "/api/ecommerce/payment-links/cancel",
        respond: { body: { id: 88, state: "cancelled" } },
      },
    ]);
    const link = await extras.links.create({
      amount,
      reference: "link_1",
      methods: ["card", "wallet"],
      expiresAt: "2026-12-01T00:00:00Z",
      customer: { name: "Sara Ali", email: "sara@example.com" },
      collect: { phone: true },
    });
    expect(link).toMatchObject({
      id: 88,
      url: "https://accept.paymob.com/standalone/?ref=abc",
      shortUrl: "https://pmob.me/abc",
    });
    const [create] = fetch.callsTo("POST", "/api/ecommerce/payment-links");
    expect(create!.form).toEqual({
      amount_cents: "25000",
      payment_methods: ["11", "22"],
      is_live: "false",
      reference_id: "link_1",
      expires_at: "2026-12-01T00:00:00.000Z",
      full_name: "Sara Ali",
      email: "sara@example.com",
      collect_phone_number: "true",
    });
    expect(create!.headers.authorization).toBe("Bearer tok_1");
    expect(create!.headers["content-type"]).toBeUndefined();
    await extras.links.cancel(88);
    expect(fetch.callsTo("POST", "/api/ecommerce/payment-links/cancel")[0]!.form).toEqual({
      payment_link_id: "88",
    });
  });
});
