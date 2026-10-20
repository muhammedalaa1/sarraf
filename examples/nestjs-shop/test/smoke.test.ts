import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Sarraf } from "@sarraf/core";
import type { FakeProvider } from "@sarraf/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule, SARRAF } from "../src/app.module.js";
import { createPay } from "../src/pay.js";

describe("nestjs-shop (demo mode)", () => {
  let app: INestApplication;
  let pay: Sarraf;

  beforeAll(async () => {
    pay = createPay({ demo: true }).pay;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SARRAF)
      .useValue(pay)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    await app.init();
  });

  afterAll(() => app.close());

  it("checks out and processes a verified webhook", async () => {
    const res = await request(app.getHttpServer())
      .post("/checkout")
      .send({ provider: "kashier", amount: 25000, phone: "+201001234567" });
    expect(res.status).toBe(201);
    expect(res.body.redirectUrl).toMatch(/^https:\/\//);

    const fake = pay.provider("kashier") as unknown as FakeProvider<"kashier">;
    const webhook = fake.simulate(res.body.reference, "succeeded");
    const w = await request(app.getHttpServer())
      .post("/webhooks/kashier")
      .set(webhook.headers as Record<string, string>)
      .send(webhook.rawBody as string);
    expect(w.status).toBe(200);
    const orders = await request(app.getHttpServer()).get("/orders");
    expect(orders.body[0].status).toBe("succeeded");
  });

  it("rejects bad signatures, unknown providers and invalid checkouts", async () => {
    const server = app.getHttpServer();
    const bad = await request(server)
      .post("/webhooks/kashier")
      .set({ "content-type": "application/json", "x-sarraf-fake-signature": "00" })
      .send("{}");
    expect(bad.status).toBe(400);
    expect((await request(server).post("/webhooks/stripe").send({})).status).toBe(404);
    const invalid = await request(server)
      .post("/checkout")
      .send({ provider: "paymob", amount: 1.5, phone: "x" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("INVALID_REQUEST");
  });
});
