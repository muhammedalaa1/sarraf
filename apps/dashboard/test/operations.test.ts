import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sarraf, silentLogger } from "@sarrafjs/core";
import { type FakeProvider, fakeProvider } from "@sarrafjs/testing";
import { describe, expect, it } from "vitest";
import { runAction } from "../lib/actions";
import { Orders } from "../lib/orders";

const tmpOrders = () => new Orders(join(mkdtempSync(join(tmpdir(), "sarraf-")), "orders.json"));

async function paidOrder() {
  const kashier = fakeProvider("kashier") as FakeProvider<"kashier">;
  const pay = new Sarraf({ providers: { kashier }, logger: silentLogger });
  const store = tmpOrders();
  const reference = `ref_${Math.random()}`;
  await pay.checkout.create({
    provider: "kashier",
    amount: { value: 25_000, currency: "EGP" },
    reference,
    customer: { phone: "+201000000000" },
  });
  kashier.simulate(reference, "succeeded");
  store.upsert("kashier", reference, { amount: { value: 25_000, currency: "EGP" } });
  return { pay, store, reference };
}

describe("Orders", () => {
  it("upserts, keeps history newest first, removes and clears", () => {
    const store = tmpOrders();
    store.upsert(
      "kashier",
      "a",
      { redirectUrl: "https://x" },
      { action: "checkout", ok: true, summary: "c" },
    );
    store.upsert("kashier", "a", { redirectUrl: undefined }, { action: "reconcile", ok: true, summary: "r" });
    const a = store.get("kashier", "a");
    expect(a?.redirectUrl).toBe("https://x");
    expect(a?.history.map((h) => h.action)).toEqual(["reconcile", "checkout"]);
    store.upsert("paymob", "b", {});
    expect(store.list().map((o) => o.key)).toEqual(["paymob:b", "kashier:a"]);
    store.remove("paymob", "b");
    expect(store.list()).toHaveLength(1);
    store.clear();
    expect(store.list()).toEqual([]);
  });
});

describe("runAction", () => {
  it("reconciles, then refunds partially and fully", async () => {
    const { pay, store, reference } = await paidOrder();
    const rec = await runAction(pay, store, { action: "reconcile", provider: "kashier", reference });
    expect(rec.ok).toBe(true);
    expect(rec.order?.payment?.status).toBe("succeeded");

    const partial = await runAction(pay, store, {
      action: "refund",
      provider: "kashier",
      reference,
      amount: "50",
    });
    expect(partial.ok).toBe(true);
    expect(partial.order?.payment?.status).toBe("partially_refunded");
    expect(partial.order?.payment?.amountRefunded.value).toBe(5_000);

    const full = await runAction(pay, store, { action: "refund", provider: "kashier", reference });
    expect(full.order?.payment?.status).toBe("refunded");
    expect(full.order?.history.map((h) => h.action)).toEqual(["refund", "refund", "reconcile"]);
  });

  it("voids", async () => {
    const { pay, store, reference } = await paidOrder();
    const res = await runAction(pay, store, { action: "cancel", provider: "kashier", reference });
    expect(res.ok).toBe(true);
    expect(res.order?.payment?.status).toBe("canceled");
  });

  it("records an unsupported capture as a failed action", async () => {
    const { pay, store, reference } = await paidOrder();
    await runAction(pay, store, { action: "reconcile", provider: "kashier", reference });
    const res = await runAction(pay, store, { action: "capture", provider: "kashier", reference });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("CAPABILITY_NOT_SUPPORTED");
    expect(store.get("kashier", reference)?.history[0]).toMatchObject({ action: "capture", ok: false });
  });

  it("asks for a reconcile before a refund, and records failures", async () => {
    const { pay, store, reference } = await paidOrder();
    const res = await runAction(pay, store, { action: "refund", provider: "kashier", reference });
    expect(res.ok).toBe(false);
    expect(res.error?.message).toMatch(/reconcile/);
    expect(store.get("kashier", reference)?.history[0]).toMatchObject({ action: "refund", ok: false });
    expect(
      (await runAction(pay, store, { action: "reconcile", provider: "kashier", reference: " " })).ok,
    ).toBe(false);
  });
});
