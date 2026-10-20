import { join } from "node:path";
import { Sarraf, silentLogger } from "@sarraf/core";
import { runConformanceTests } from "@sarraf/core/conformance";
import { describe, expect, it } from "vitest";
import { createMockFetch, fakeProvider, findFixturesDir, listFixtures, loadFixture } from "../src/index.js";

const input = {
  provider: "paymob" as const,
  amount: { value: 25000, currency: "EGP" as const },
  reference: "order_1",
  customer: { phone: "+201001234567" },
};

runConformanceTests("fakeProvider", async () => {
  const fake = fakeProvider("paymob");
  const sarraf = new Sarraf({ providers: { paymob: fake }, logger: silentLogger });
  await fake.createCheckout({ ...input, reference: "paid" }, sarraf.ctx);
  const succeeded = fake.simulate("paid", "succeeded");
  const tampered = { ...succeeded, rawBody: (succeeded.rawBody as string).replace("25000", "1") };
  const paid = fake.payments.get("paid")!;
  let calls = 0;
  const original = fake.createCheckout;
  fake.createCheckout = (i, c) => {
    calls++;
    return original(i, c);
  };
  return {
    sarraf,
    provider: "paymob",
    checkoutInput: input,
    expectedCheckoutKind: "redirect",
    webhooks: { succeeded, tampered, reference: "paid" },
    lookup: { reference: "paid" },
    refund: { providerPaymentId: paid.providerPaymentId },
    fetchCalls: () => calls,
  };
});

describe("fakeProvider", () => {
  it("supports reference codes, refunds, cancel and duplicate detection", async () => {
    const fake = fakeProvider("fawry", { checkoutKind: "reference_code" });
    const pay = new Sarraf({ providers: { fawry: fake }, logger: silentLogger });
    const c = await pay.checkout.create({ ...input, provider: "fawry" });
    expect(c.referenceCode).toBe("900000001");
    expect(Date.parse(c.expiresAt ?? "")).toBeGreaterThan(Date.now());
    expect(c.payment.status).toBe("awaiting_payment");
    await expect(pay.checkout.create({ ...input, provider: "fawry" })).rejects.toMatchObject({
      code: "DUPLICATE_REFERENCE",
    });
    await expect(pay.refunds.create({ provider: "fawry", providerPaymentId: "1" })).rejects.toThrow(
      /only paid/,
    );
    fake.simulate("order_1", "succeeded");
    const r = await pay.refunds.create({
      provider: "fawry",
      providerPaymentId: "1",
      amount: { value: 100, currency: "EGP" },
    });
    expect(r.payment?.status).toBe("partially_refunded");
    expect((await pay.payments.cancel({ provider: "fawry", reference: "order_1" })).status).toBe("canceled");
    await expect(pay.payments.get({ provider: "fawry", reference: "nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(() => fake.simulate("nope", "succeeded")).toThrow(/unknown reference/);
    const refunded = fake.simulate("order_1", "refunded");
    expect(JSON.parse(refunded.rawBody as string).amountRefunded.value).toBe(25000);
    const missing = await pay.webhooks.inspect("fawry", { rawBody: "{}" });
    expect(missing.reason).toMatch(/missing/);
  });

  it("sends redirect checkouts to a configurable fake payment page", async () => {
    const fake = fakeProvider("paymob", { redirectBaseUrl: "http://localhost:3000/demo/pay/" });
    const pay = new Sarraf({ providers: { paymob: fake }, logger: silentLogger });
    const c = await pay.checkout.create({ ...input, reference: "order 7" });
    expect(c.redirectUrl).toBe("http://localhost:3000/demo/pay/1?reference=order%207");
    const d = await new Sarraf({
      providers: { paymob: fakeProvider("paymob") },
      logger: silentLogger,
    }).checkout.create(input);
    expect(d.redirectUrl).toMatch(/^https:\/\/fake\.sarraf\.dev\/pay\/1\?reference=order_1$/);
  });
});

describe("createMockFetch", () => {
  it("routes by method and path, records calls, honors times", async () => {
    const f = createMockFetch([
      { method: "POST", url: "/a", respond: (req) => ({ body: { got: req.json } }), times: 1 },
      { method: "POST", url: "/a", respond: { status: 500, body: "down" } },
      { url: /\/b\?x=1$/, respond: { body: { b: true }, headers: { "x-y": "z" } } },
      { url: "/empty", respond: {} },
    ]);
    const a = await f("https://x.test/a", {
      method: "POST",
      body: '{"n":1}',
      headers: { "Content-Type": "j" },
    });
    expect(await a.json()).toEqual({ got: { n: 1 } });
    const a2 = await f("https://x.test/a", { method: "POST", body: "not json" });
    expect(a2.status).toBe(500);
    expect(await a2.text()).toBe("down");
    const b = await f("https://x.test/b?x=1", {});
    expect(b.headers.get("x-y")).toBe("z");
    expect((await f("https://x.test/empty", {})).status).toBe(200);
    expect(f.calls).toHaveLength(4);
    expect(f.calls[0]!.headers["content-type"]).toBe("j");
    expect(f.callsTo("POST", "/a")).toHaveLength(2);
    await expect(f("https://x.test/zzz", {})).rejects.toThrow(/no route for GET/);
    f.reset();
    expect(f.calls).toHaveLength(0);
  });
});

describe("fixtures", () => {
  const root = join(__dirname, "fixtures");
  it("loads and lists fixtures", () => {
    expect(loadFixture("demo", "ok", root).source).toBe("synthetic");
    expect(listFixtures("demo", root)).toEqual(["ok"]);
    expect(listFixtures("none", root)).toEqual([]);
    expect(() => loadFixture("demo", "missing", root)).toThrow(/not found/);
  });

  it("finds the fixtures dir by walking up", () => {
    expect(findFixturesDir(join(__dirname, "fixtures", "demo"))).toBe(root);
    expect(() => findFixturesDir("C:/")).toThrow(/No fixtures/);
  });
});
