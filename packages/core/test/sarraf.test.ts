import { describe, expect, it, vi } from "vitest";
import { isSarrafError, SarrafError } from "../src/errors.js";
import { HttpClient } from "../src/http.js";
import { silentLogger } from "../src/logger.js";
import { Sarraf, stableStringify } from "../src/sarraf.js";
import type { Capabilities, CreateCheckoutInput, Payment, PaymentProvider } from "../src/types.js";

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  checkout: "supported",
  getPayment: "supported",
  refund: "supported",
  partialRefund: "supported",
  cancel: "supported",
  webhooks: "supported",
  redirectVerification: "supported",
  methods: { card: "supported", wallet: "beta" },
  currencies: ["EGP"],
  checkoutKinds: ["redirect"],
  docsUrl: "https://sarraf.dev/providers/paymob",
  ...over,
});

const payment = (status: Payment["status"] = "pending"): Payment => ({
  id: "paymob_1",
  provider: "paymob",
  providerPaymentId: "1",
  reference: "order_1",
  status,
  amount: { value: 25000, currency: "EGP" },
  amountRefunded: { value: 0, currency: "EGP" },
  raw: {},
});

function fake(over: Partial<PaymentProvider<"paymob">> = {}) {
  const provider: PaymentProvider<"paymob"> = {
    id: "paymob",
    capabilities: caps(),
    createCheckout: vi.fn(async () => ({
      id: "paymob_c1",
      provider: "paymob" as const,
      kind: "redirect" as const,
      redirectUrl: "https://pay.test",
      payment: payment(),
      raw: {},
    })),
    getPayment: vi.fn(async () => payment("succeeded")),
    refund: vi.fn(async (input) => ({
      id: "r1",
      provider: "paymob" as const,
      providerPaymentId: input.providerPaymentId,
      status: "succeeded" as const,
      raw: {},
    })),
    cancel: vi.fn(async () => payment("canceled")),
    inspectWebhook: vi.fn(async () => ({ valid: true, algorithm: "none", signedString: "x" })),
    verifyWebhook: vi.fn(async () => ({ provider: "paymob" as const, body: {}, headers: {}, query: {} })),
    parseWebhook: vi.fn(async () => ({
      id: "paymob:1:succeeded",
      type: "payment.succeeded" as const,
      provider: "paymob" as const,
      payment: payment("succeeded"),
      receivedAt: new Date(0).toISOString(),
      raw: {},
    })),
    verifyRedirect: vi.fn(async (q) => ({
      provider: "paymob" as const,
      authenticated: false,
      status: "unknown" as const,
      raw: q,
    })),
    ...over,
  };
  return provider;
}

const input: CreateCheckoutInput<"paymob"> = {
  provider: "paymob",
  amount: { value: 25000, currency: "EGP" },
  reference: "order_1",
  customer: { phone: "+201001234567", email: "sara@example.com" },
};

const make = (provider = fake(), opts = {}) =>
  new Sarraf({ providers: { paymob: provider }, logger: silentLogger, ...opts });

describe("Sarraf construction", () => {
  it("requires providers registered under their own id", () => {
    expect(() => new Sarraf({ providers: {} })).toThrow(/at least one provider/);
    expect(() => new Sarraf({ providers: { kashier: fake() as never } })).toThrow(
      /must be the kashier\(\) adapter/,
    );
    expect(() => new Sarraf({ providers: { kashier: undefined as never } })).toThrow(/got nothing/);
  });

  it("accepts an HttpClient instance and exposes provider ids", () => {
    const http = new HttpClient({ fetch: async () => new Response("") });
    const pay = make(fake(), { http, debug: true });
    expect(pay.ctx.http).toBe(http);
    expect(pay.providerIds).toEqual(["paymob"]);
    expect(pay.capabilities("paymob").checkout).toBe("supported");
  });

  it("throws for unconfigured providers", () => {
    const pay = make();
    expect(() => pay.provider("fawry" as never)).toThrow(/not configured/);
  });
});

describe("checkout.create", () => {
  it("validates input before calling the provider", async () => {
    const p = fake();
    const pay = make(p);
    await expect(
      pay.checkout.create({ ...input, amount: { value: 250.5, currency: "EGP" } }),
    ).rejects.toThrow(/minor units/);
    await expect(pay.checkout.create({ ...input, customer: { phone: "" } })).rejects.toThrow(/phone/);
    await expect(
      pay.checkout.create({
        ...input,
        items: [{ name: "a", unitAmount: { value: 100, currency: "EGP" }, quantity: 2 }],
      }),
    ).rejects.toThrow(/items total 200 must equal amount 25000/);
    await expect(
      pay.checkout.create({
        ...input,
        amount: { value: 200, currency: "EGP" },
        items: [{ name: "a", unitAmount: { value: 200, currency: "SAR" }, quantity: 1 }],
      }),
    ).rejects.toThrow(/currency must match/);
    await expect(
      pay.checkout.create({ ...input, amount: { value: 1, currency: "XXX" as never } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CURRENCY" });
    expect(p.createCheckout).not.toHaveBeenCalled();
  });

  it("checks provider currencies and methods", async () => {
    const pay = make();
    await expect(
      pay.checkout.create({ ...input, amount: { value: 1, currency: "SAR" } }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_CURRENCY",
    });
    await expect(pay.checkout.create({ ...input, methods: ["cash_outlet"] })).rejects.toMatchObject({
      code: "CAPABILITY_NOT_SUPPORTED",
    });
    const err = await pay.checkout.create({ ...input, methods: ["wallet"] }).catch((e) => e);
    expect(err.message).toMatch(/Paymob method "wallet" is beta.*allowBeta/);
    await expect(
      make(fake(), { allowBeta: true }).checkout.create({ ...input, methods: ["wallet"] }),
    ).resolves.toBeTruthy();
  });

  it("is idempotent per key", async () => {
    const p = fake();
    const pay = make(p);
    const a = await pay.checkout.create({ ...input, idempotencyKey: "k1" });
    const b = await pay.checkout.create({ ...input, idempotencyKey: "k1" });
    expect(b).toEqual(a);
    expect(p.createCheckout).toHaveBeenCalledTimes(1);
    await pay.checkout.create(input);
    await pay.checkout.create(input);
    expect(p.createCheckout).toHaveBeenCalledTimes(3);
  });

  it("rejects reusing a key with different params", async () => {
    const pay = make();
    await pay.checkout.create({ ...input, idempotencyKey: "k" });
    await expect(pay.checkout.create({ ...input, reference: "other", idempotencyKey: "k" })).rejects.toThrow(
      /different parameters/,
    );
  });

  it("releases the key after a definite failure, keeps it after an unknown outcome", async () => {
    const createCheckout = vi
      .fn()
      .mockRejectedValueOnce(new SarrafError("INVALID_REQUEST", "bad"))
      .mockRejectedValueOnce(new SarrafError("TIMEOUT_UNKNOWN_OUTCOME", "?"))
      .mockResolvedValue({ id: "x" });
    const pay = make(fake({ createCheckout }));
    await expect(pay.checkout.create({ ...input, idempotencyKey: "a" })).rejects.toThrow(/bad/);
    await expect(pay.checkout.create({ ...input, idempotencyKey: "a" })).rejects.toThrow(
      /TIMEOUT_UNKNOWN_OUTCOME/,
    );
    const err = await pay.checkout.create({ ...input, idempotencyKey: "a" }).catch((e) => e);
    expect(err.message).toMatch(/still in progress or ended with an unknown outcome/);
    expect(createCheckout).toHaveBeenCalledTimes(2);
  });

  it("retries the claim when the record expired between calls", async () => {
    let calls = 0;
    const store = {
      get: async () => undefined,
      set: async () => {},
      setIfAbsent: async () => ++calls > 1,
      delete: async () => {},
    };
    const pay = make(fake(), { idempotency: store });
    await expect(pay.checkout.create({ ...input, idempotencyKey: "z" })).resolves.toBeTruthy();
    expect(calls).toBe(2);
  });

  it("refuses unsupported or beta checkout", async () => {
    await expect(
      make(fake({ capabilities: caps({ checkout: "unsupported" }) })).checkout.create(input),
    ).rejects.toThrow(/does not support checkout/);
  });
});

describe("payments, refunds, webhooks, redirects", () => {
  it("gets, reconciles and cancels", async () => {
    const p = fake();
    const pay = make(p);
    expect((await pay.payments.get({ provider: "paymob", providerPaymentId: "1" })).status).toBe("succeeded");
    expect((await pay.payments.reconcile({ provider: "paymob", reference: "order_1" })).status).toBe(
      "succeeded",
    );
    expect(p.getPayment).toHaveBeenLastCalledWith({ reference: "order_1" }, pay.ctx);
    expect((await pay.payments.cancel({ provider: "paymob", providerPaymentId: "1" })).status).toBe(
      "canceled",
    );
    await expect(pay.payments.get({ provider: "paymob" })).rejects.toThrow(/providerPaymentId or reference/);
    await expect(pay.payments.cancel({ provider: "paymob" })).rejects.toThrow(
      /providerPaymentId or reference/,
    );
  });

  it("reports missing optional methods as unsupported", async () => {
    const { cancel: _c, refund: _r, verifyRedirect: _v, ...withoutOptional } = fake();
    const pay = make(withoutOptional as PaymentProvider<"paymob">);
    await expect(pay.payments.cancel({ provider: "paymob", providerPaymentId: "1" })).rejects.toMatchObject({
      code: "CAPABILITY_NOT_SUPPORTED",
    });
    await expect(pay.refunds.create({ provider: "paymob", providerPaymentId: "1" })).rejects.toMatchObject({
      code: "CAPABILITY_NOT_SUPPORTED",
    });
    await expect(pay.redirects.verify("paymob", {})).rejects.toMatchObject({
      code: "CAPABILITY_NOT_SUPPORTED",
    });
  });

  it("refunds with validation, partial-refund capability and idempotency", async () => {
    const p = fake();
    const pay = make(p);
    await pay.refunds.create({ provider: "paymob", providerPaymentId: "1", idempotencyKey: "r" });
    await pay.refunds.create({ provider: "paymob", providerPaymentId: "1", idempotencyKey: "r" });
    expect(p.refund).toHaveBeenCalledTimes(1);
    expect(p.refund).toHaveBeenCalledWith({ providerPaymentId: "1", idempotencyKey: "r" }, pay.ctx);
    await expect(pay.refunds.create({ provider: "paymob", providerPaymentId: "" })).rejects.toThrow(
      /providerPaymentId/,
    );
    const noPartial = make(fake({ capabilities: caps({ partialRefund: "unsupported" }) }));
    await expect(
      noPartial.refunds.create({
        provider: "paymob",
        providerPaymentId: "1",
        amount: { value: 1, currency: "EGP" },
      }),
    ).rejects.toThrow(/partialRefund/);
  });

  it("routes webhooks and redirects", async () => {
    const pay = make();
    const event = await pay.webhooks.verifyAndParse("paymob", { rawBody: "{}" });
    expect(pay.webhooks.dedupeKey(event)).toBe("paymob:1:succeeded");
    expect((await pay.webhooks.inspect("paymob", { rawBody: "{}" })).valid).toBe(true);
    expect((await pay.redirects.verify("paymob", { a: "1" })).raw).toEqual({ a: "1" });
  });

  it("propagates signature failures", async () => {
    const pay = make(
      fake({
        verifyWebhook: async () => {
          throw new SarrafError("WEBHOOK_SIGNATURE_INVALID", "nope");
        },
      }),
    );
    const err = await pay.webhooks.verifyAndParse("paymob", { rawBody: "{}" }).catch((e) => e);
    expect(isSarrafError(err, "WEBHOOK_SIGNATURE_INVALID")).toBe(true);
  });
});

describe("stableStringify", () => {
  it("sorts keys and drops undefined", () => {
    expect(stableStringify({ b: 1, a: [{ d: 1, c: undefined }], e: null })).toBe(
      '{"a":[{"d":1}],"b":1,"e":null}',
    );
    expect(stableStringify(undefined)).toBe("null");
  });
});
