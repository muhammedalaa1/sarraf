import { Sarraf, SarrafError, silentLogger } from "@sarrafjs/core";
import { fakeProvider } from "@sarrafjs/testing";
import { describe, expect, it, vi } from "vitest";
import { verifyRedirect, webhookRoute } from "../src/index.js";

async function setup() {
  const fake = fakeProvider("paymob");
  const pay = new Sarraf({ providers: { paymob: fake }, logger: silentLogger });
  await pay.checkout.create({
    provider: "paymob",
    amount: { value: 100, currency: "EGP" },
    reference: "o1",
    customer: { phone: "0100000000" },
  });
  return { pay, fake };
}

function post(url: string, webhook: { rawBody: unknown; headers?: unknown }) {
  return new Request(url, {
    method: "POST",
    body: webhook.rawBody as string,
    headers: webhook.headers as Record<string, string>,
  });
}

describe("webhookRoute", () => {
  it("verifies, dispatches and answers 200", async () => {
    const { pay, fake } = await setup();
    const onEvent = vi.fn();
    const POST = webhookRoute(pay, onEvent, { logger: silentLogger });
    const res = await POST(post("http://localhost/api/webhooks/paymob", fake.simulate("o1", "succeeded")), {
      params: Promise.resolve({ provider: "paymob" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, id: "paymob:1:succeeded" });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "payment.succeeded" }));
  });

  it("supports a fixed provider, a custom param, plain params and a lazy client", async () => {
    const { pay, fake } = await setup();
    const onEvent = vi.fn();
    const fixed = webhookRoute(() => pay, onEvent, { provider: "paymob", logger: silentLogger });
    expect((await fixed(post("http://localhost/w", fake.simulate("o1", "succeeded")))).status).toBe(200);
    const custom = webhookRoute(pay, onEvent, { param: "gateway", logger: silentLogger });
    const res = await custom(post("http://localhost/w", fake.simulate("o1", "failed")), {
      params: { gateway: ["paymob", "extra"] },
    });
    expect(res.status).toBe(200);
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it("passes the URL query to verification", async () => {
    const { pay } = await setup();
    const verify = vi.spyOn(pay.webhooks, "verifyAndParse").mockRejectedValue(new Error("x"));
    const POST = webhookRoute(pay, () => {}, { provider: "paymob", logger: silentLogger });
    await POST(post("http://localhost/cb?hmac=abc", { rawBody: "{}" }));
    expect(verify.mock.calls[0]?.[1]).toMatchObject({ rawBody: "{}", query: { hmac: "abc" } });
  });

  it("rejects unknown providers and bad signatures", async () => {
    const { pay, fake } = await setup();
    const onEvent = vi.fn();
    const POST = webhookRoute(pay, onEvent, { logger: silentLogger });
    const unknown = await POST(post("http://localhost/w", { rawBody: "{}" }), {
      params: Promise.resolve({ provider: "stripe" }),
    });
    expect(unknown.status).toBe(404);
    expect((await POST(post("http://localhost/w", { rawBody: "{}" }))).status).toBe(404);
    const webhook = fake.simulate("o1", "succeeded");
    const bad = await POST(
      post("http://localhost/w", {
        rawBody: webhook.rawBody,
        headers: { ...(webhook.headers as Record<string, string>), "x-sarraf-fake-signature": "00" },
      }),
      { params: { provider: "paymob" } },
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "WEBHOOK_SIGNATURE_INVALID" });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("maps unexpected processing errors to 500", async () => {
    const { pay, fake } = await setup();
    fake.parseWebhook = async () => {
      throw new Error("boom");
    };
    const POST = webhookRoute(pay, () => {}, { provider: "paymob", logger: silentLogger });
    const res = await POST(post("http://localhost/w", fake.simulate("o1", "succeeded")));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "WEBHOOK_PROCESSING_FAILED" });
  });

  it("answers 500 when the handler throws so the provider retries", async () => {
    const { pay, fake } = await setup();
    const POST = webhookRoute(
      pay,
      async () => {
        throw new Error("db down");
      },
      { provider: "paymob", logger: silentLogger },
    );
    const res = await POST(post("http://localhost/w", fake.simulate("o1", "succeeded")));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "HANDLER_FAILED" });
  });

  it("acks first with defer, then logs handler errors", async () => {
    const { pay, fake } = await setup();
    const tasks: (() => Promise<void>)[] = [];
    const logger = { ...silentLogger, error: vi.fn() };
    const onEvent = vi.fn(async () => {
      throw new Error("queue down");
    });
    const POST = webhookRoute(pay, onEvent, {
      provider: "paymob",
      logger,
      defer: (task) => tasks.push(task),
    });
    const res = await POST(post("http://localhost/w", fake.simulate("o1", "succeeded")));
    expect(res.status).toBe(200);
    expect(onEvent).not.toHaveBeenCalled();
    await tasks[0]?.();
    expect(onEvent).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("after ack"), expect.anything());
    const ok = webhookRoute(pay, () => {}, { provider: "paymob", logger, defer: (t) => tasks.push(t) });
    await ok(post("http://localhost/w", fake.simulate("o1", "failed")));
    await tasks[1]?.();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe("verifyRedirect", () => {
  it("returns an unauthenticated result for providers that do not sign redirects", async () => {
    const { pay } = await setup();
    const r = await verifyRedirect(pay, "paymob", Promise.resolve({ reference: "o1", tag: ["a", "b"] }));
    expect(r).toEqual({
      provider: "paymob",
      authenticated: false,
      status: "unknown",
      reference: "o1",
      raw: { reference: "o1", tag: "a" },
    });
    expect((await verifyRedirect(pay, "stripe", "reference=o2")).reference).toBe("o2");
  });

  it("verifies with the adapter and accepts every searchParams shape", async () => {
    const { pay, fake } = await setup();
    const verify = vi.fn(async (query: Record<string, string>) => ({
      provider: "paymob" as const,
      authenticated: true,
      status: "succeeded" as const,
      reference: query.reference,
      raw: query,
    }));
    fake.verifyRedirect = verify;
    fake.capabilities.redirectVerification = "supported";
    const r = await verifyRedirect(pay, "paymob", new URLSearchParams("reference=o1&hmac=x&hmac=y"));
    expect(r.authenticated).toBe(true);
    expect(verify.mock.calls[0]?.[0]).toEqual({ reference: "o1", hmac: "x" });
    await verifyRedirect(pay, "paymob", Promise.resolve("reference=o3"));
    await verifyRedirect(pay, "paymob", { reference: "o4", skip: undefined });
    expect(verify.mock.calls.map((c) => c[0])).toEqual([
      { reference: "o1", hmac: "x" },
      { reference: "o3" },
      { reference: "o4" },
    ]);
  });

  it("rethrows errors other than an unsupported capability", async () => {
    const { pay, fake } = await setup();
    fake.capabilities.redirectVerification = "supported";
    fake.verifyRedirect = async () => {
      throw new SarrafError("CONFIGURATION_INVALID", "nope");
    };
    await expect(verifyRedirect(pay, "paymob", {})).rejects.toThrow("nope");
  });
});
