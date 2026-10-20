import { createServer } from "node:http";
import { Sarraf, silentLogger } from "@sarraf/core";
import { fakeProvider } from "@sarraf/testing";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { type RawBodyRequest, rawBody, webhookHandler } from "../src/index.js";

async function setup(mode?: "handle-first" | "ack-first", onEvent = vi.fn()) {
  const fake = fakeProvider("paymob");
  const pay = new Sarraf({ providers: { paymob: fake }, logger: silentLogger });
  await fake.createCheckout(
    {
      provider: "paymob",
      amount: { value: 100, currency: "EGP" },
      reference: "o1",
      customer: { phone: "0100000000" },
    },
    pay.ctx,
  );
  const app = express();
  app.post("/webhooks/:provider", rawBody(), webhookHandler(pay, onEvent, { mode, logger: silentLogger }));
  app.post("/fixed", rawBody(), webhookHandler(pay, onEvent, { provider: "paymob", logger: silentLogger }));
  app.post(
    "/no-raw",
    express.json(),
    webhookHandler(pay, onEvent, { logger: silentLogger, provider: "paymob" }),
  );
  return { app, fake, onEvent };
}

describe("webhookHandler", () => {
  it("verifies, dispatches and answers 200", async () => {
    const { app, fake, onEvent } = await setup();
    const req = fake.simulate("o1", "succeeded");
    const res = await request(app)
      .post("/webhooks/paymob")
      .set(req.headers as Record<string, string>)
      .send(req.rawBody as string);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, id: "paymob:1:succeeded" });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "payment.succeeded" }));
    const fixed = await request(app)
      .post("/fixed")
      .set(req.headers as Record<string, string>)
      .send(req.rawBody as string);
    expect(fixed.status).toBe(200);
  });

  it("rejects bad signatures, unknown providers and missing raw bodies", async () => {
    const { app, fake, onEvent } = await setup();
    const req = fake.simulate("o1", "succeeded");
    const bad = await request(app)
      .post("/webhooks/paymob")
      .set({ ...(req.headers as Record<string, string>), "x-sarraf-fake-signature": "00" })
      .send(req.rawBody as string);
    expect(bad.status).toBe(400);
    expect((await request(app).post("/webhooks/stripe").send("{}")).status).toBe(404);
    const noRaw = await request(app)
      .post("/no-raw")
      .set("content-type", "application/json")
      .send(req.rawBody as string);
    expect(noRaw.status).toBe(500);
    expect(noRaw.body.error).toBe("RAW_BODY_MISSING");
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("answers 500 when the handler throws (handle-first) so the provider retries", async () => {
    const { app, fake } = await setup(
      "handle-first",
      vi.fn(async () => {
        throw new Error("db down");
      }),
    );
    const req = fake.simulate("o1", "succeeded");
    const res = await request(app)
      .post("/webhooks/paymob")
      .set(req.headers as Record<string, string>)
      .send(req.rawBody as string);
    expect(res.status).toBe(500);
  });

  it("acks first, then swallows handler errors (ack-first)", async () => {
    const onEvent = vi.fn(async () => {
      throw new Error("queue down");
    });
    const { app, fake } = await setup("ack-first", onEvent);
    const req = fake.simulate("o1", "succeeded");
    const res = await request(app)
      .post("/webhooks/paymob")
      .set(req.headers as Record<string, string>)
      .send(req.rawBody as string);
    expect(res.status).toBe(200);
    expect(onEvent).toHaveBeenCalled();
    const ok = await setup("ack-first");
    const r2 = ok.fake.simulate("o1", "failed");
    const res2 = await request(ok.app)
      .post("/webhooks/paymob")
      .set(r2.headers as Record<string, string>)
      .send(r2.rawBody as string);
    expect(res2.body.id).toBe("paymob:1:failed");
  });

  it("maps unexpected errors to 500", async () => {
    const pay = new Sarraf({ providers: { paymob: fakeProvider("paymob") }, logger: silentLogger });
    const app = express();
    app.post(
      "/w/:provider",
      rawBody(),
      webhookHandler(pay, () => {}, { logger: silentLogger }),
    );
    // Valid signature over a body whose payment is malformed → parse error, not a signature error.
    const fake = pay.provider("paymob") as ReturnType<typeof fakeProvider>;
    fake.parseWebhook = async () => {
      throw new Error("boom");
    };
    const signed = fakeProvider("paymob");
    await signed.createCheckout(
      {
        provider: "paymob",
        amount: { value: 1, currency: "EGP" },
        reference: "x",
        customer: { phone: "0100000000" },
      },
      pay.ctx,
    );
    const r = signed.simulate("x", "succeeded");
    const res = await request(app)
      .post("/w/paymob")
      .set(r.headers as Record<string, string>)
      .send(r.rawBody as string);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("WEBHOOK_PROCESSING_FAILED");
  });

  it("reads the query from the URL without express", async () => {
    const pay = new Sarraf({ providers: { paymob: fakeProvider("paymob") }, logger: silentLogger });
    const verify = vi.spyOn(pay.webhooks, "verifyAndParse").mockRejectedValue(new Error("x"));
    const handler = webhookHandler(pay, () => {}, { provider: "paymob", logger: silentLogger });
    const server = createServer((req, res) => {
      (req as RawBodyRequest).rawBody = Buffer.from("{}");
      void handler(req as RawBodyRequest, res);
    });
    await request(server).post("/cb?hmac=abc").send("{}");
    expect(verify.mock.calls[0]![1].query).toEqual({ hmac: "abc" });
  });
});

describe("rawBody", () => {
  function app(opts?: Parameters<typeof rawBody>[0]) {
    const a = express();
    a.post("/", rawBody(opts), rawBody(), (req: RawBodyRequest, res) => {
      res.json({ raw: req.rawBody?.toString("utf8"), body: req.body ?? null });
    });
    return a;
  }

  it("keeps exact bytes and parses JSON", async () => {
    const raw = '{"amount": 250.00,  "name":"مرحبا"}';
    const res = await request(app()).post("/").set("content-type", "application/json").send(raw);
    expect(res.body.raw).toBe(raw);
    expect(res.body.body).toEqual({ amount: 250, name: "مرحبا" });
  });

  it("skips JSON parsing when disabled, non-JSON or invalid", async () => {
    expect(
      (
        await request(app({ json: false }))
          .post("/")
          .set("content-type", "application/json")
          .send("{}")
      ).body.body,
    ).toBeNull();
    expect((await request(app()).post("/").set("content-type", "text/plain").send("hi")).body).toEqual({
      raw: "hi",
      body: null,
    });
    expect(
      (await request(app()).post("/").set("content-type", "application/json").send("{bad")).body.body,
    ).toBeNull();
  });

  it("enforces the size limit", async () => {
    const res = await request(app({ limit: 5 }))
      .post("/")
      .set("content-type", "text/plain")
      .send("0123456789");
    expect(res.status).toBe(413);
  });

  it("forwards stream errors", async () => {
    const mw = rawBody();
    const handlers: Record<string, (arg?: unknown) => void> = {};
    const req = {
      on: (ev: string, fn: (arg?: unknown) => void) => {
        handlers[ev] = fn;
      },
      headers: {},
    } as never;
    const next = vi.fn();
    mw(req, {} as never, next);
    handlers.error!(new Error("reset"));
    handlers.error!(new Error("again"));
    handlers.end!();
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]![0]).toBeInstanceOf(Error);
  });
});
