import type { FakeProvider } from "@sarrafjs/testing";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { POST } = await import("../app/api/webhooks/[provider]/route");
const { getPay, orders } = await import("../lib/pay");

const call = (provider: string, body: string, headers: Record<string, string>) =>
  POST(new Request(`http://localhost/api/webhooks/${provider}`, { method: "POST", body, headers }), {
    params: Promise.resolve({ provider }),
  });

describe("nextjs-shop webhook route (demo mode)", () => {
  it("verifies and applies webhooks", async () => {
    const { pay } = getPay();
    const checkout = await pay.checkout.create({
      provider: "fawry",
      amount: { value: 1000, currency: "EGP" },
      reference: "order_next_1",
      customer: { phone: "+201001234567" },
    });
    orders.set("order_next_1", {
      reference: "order_next_1",
      provider: "fawry",
      quantity: 1,
      amount: { value: 1000, currency: "EGP" },
      refunded: { value: 0, currency: "EGP" },
      status: checkout.payment.status,
      createdAt: Date.now(),
    });
    const fake = pay.provider("fawry") as unknown as FakeProvider<"fawry">;
    const webhook = fake.simulate("order_next_1", "succeeded");
    const res = await call("fawry", webhook.rawBody as string, webhook.headers as Record<string, string>);
    expect(res.status).toBe(200);
    expect(orders.get("order_next_1")?.status).toBe("succeeded");
    // a retried delivery is acknowledged but not applied twice
    const again = await call("fawry", webhook.rawBody as string, webhook.headers as Record<string, string>);
    expect(again.status).toBe(200);
  });

  it("rejects bad signatures and unknown providers", async () => {
    expect((await call("fawry", "{}", { "x-sarraf-fake-signature": "00" })).status).toBe(400);
    expect((await call("stripe", "{}", {})).status).toBe(404);
  });
});
