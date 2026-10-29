import type { FakeProvider } from "@sarrafjs/testing";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type Order, reconcilePending, Store } from "../src/app.js";
import { createPay } from "../src/pay.js";

function demoShop() {
  const { pay } = createPay({ demo: true });
  const store = new Store();
  const app = createApp(pay, { store, demo: true });
  const only = (): Order => {
    const [order] = store.orders.values();
    if (!order) throw new Error("no order");
    return order;
  };
  return { pay, store, app, only };
}

describe("express-shop (demo mode)", () => {
  it("renders the shop with every configured provider", async () => {
    const { app } = demoShop();
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Field Notes");
    expect(res.text).toContain("Demo mode");
    for (const label of ["Paymob", "Kashier", "Fawry"]) expect(res.text).toContain(label);
    expect((await request(app).get("/static/style.css")).status).toBe(200);
  });

  it("card flow: checkout → fake hosted page → signed webhook → paid, then refund", async () => {
    const { app, store, only } = demoShop();
    const res = await request(app)
      .post("/checkout")
      .type("form")
      .send({ provider: "paymob", quantity: "2", phone: "+201001234567" });
    expect(res.status).toBe(303);
    const location = new URL(res.headers.location as string);
    expect(location.pathname).toMatch(/^\/demo\/pay\//);
    expect(only()).toMatchObject({ provider: "paymob", quantity: 2, status: "pending" });
    expect(only().amount).toEqual({ value: 50000, currency: "EGP" });

    const hosted = await request(app).get(location.pathname + location.search);
    expect(hosted.text).toContain("EGP 500.00");

    const approve = await request(app)
      .post(`/demo/pay/${only().reference}`)
      .type("form")
      .send({ outcome: "succeeded" });
    expect(approve.status).toBe(303);
    expect(only().status).toBe("succeeded");

    const thanks = await request(app).get(approve.headers.location as string);
    expect(thanks.text).toContain("Payment received");
    expect(thanks.text).toContain("Thanks!");

    const refund = await request(app).post(`/orders/${only().reference}/refund`);
    expect(refund.status).toBe(200);
    expect(only().status).toBe("refunded");
    expect(store.processedEvents.size).toBe(1);
  });

  it("declined payments show an error and stay failed", async () => {
    const { app, only } = demoShop();
    await request(app).post("/checkout").type("form").send({ provider: "kashier", phone: "+201001234567" });
    await request(app).post(`/demo/pay/${only().reference}`).type("form").send({ outcome: "failed" });
    expect(only().status).toBe("failed");
    const page = await request(app).get(`/orders/${only().reference}`);
    expect(page.text).toContain("failed");
    expect(page.text).not.toContain(">Refund<");
  });

  it("deduplicates repeated webhooks on event.id", async () => {
    const { app, pay, store, only } = demoShop();
    await request(app).post("/checkout").type("form").send({ provider: "paymob", phone: "+201001234567" });
    const fake = pay.provider("paymob") as unknown as FakeProvider<"paymob">;
    const webhook = fake.simulate(only().reference, "succeeded");
    for (let i = 0; i < 2; i++) {
      const w = await request(app)
        .post("/api/webhooks/paymob")
        .set(webhook.headers as Record<string, string>)
        .send(webhook.rawBody as string);
      expect(w.status).toBe(200);
    }
    expect(store.processedEvents.size).toBe(1);
    expect((await request(app).get("/orders.json")).body[0].status).toBe("succeeded");
    expect((await request(app).get("/orders")).text).toContain("succeeded");
  });

  it("Fawry flow: shows the reference code, outlet payment, and reconciles stale orders", async () => {
    const { app, pay, store, only } = demoShop();
    const res = await request(app)
      .post("/checkout")
      .type("form")
      .send({ provider: "fawry", quantity: "1", phone: "+201001234567" });
    expect(res.headers.location).toBe(`/orders/${only().reference}`);
    const page = await request(app).get(res.headers.location as string);
    expect(page.text).toMatch(/class="code">9\d{8}</);
    expect(page.text).toContain('http-equiv="refresh"');

    (pay.provider("fawry") as unknown as FakeProvider<"fawry">).simulate(only().reference, "succeeded");
    await reconcilePending(pay, store, 0);
    expect(only().status).toBe("succeeded");
  });

  it("re-renders the form with a validation error", async () => {
    const { app } = demoShop();
    const res = await request(app).post("/checkout").type("form").send({ provider: "kashier", phone: "1" });
    expect(res.status).toBe(400);
    expect(res.text).toContain("phone");
    expect(res.text).toContain('class="notice bad"');
  });

  it("escapes user input", async () => {
    const { app } = demoShop();
    const res = await request(app)
      .post("/checkout")
      .type("form")
      .send({ provider: "kashier", phone: '"><i>' }); // too short: the form is re-rendered with it
    expect(res.status).toBe(400);
    expect(res.text).not.toContain('"><i>');
    expect(res.text).toContain("&quot;&gt;&lt;i&gt;");
  });

  it("returns 404 pages for unknown orders", async () => {
    const { app } = demoShop();
    expect((await request(app).get("/orders/nope")).status).toBe(404);
    expect((await request(app).get("/thanks/paymob?reference=nope")).status).toBe(404);
  });
});
