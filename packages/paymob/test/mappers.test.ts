import { describe, expect, it } from "vitest";
import { PAYMOB_STATUS_TABLE, mapPaymobStatus, toPaymobPayment } from "../src/index.js";
import { mapPaymobMethod, merchantReference, orderId } from "../src/mappers.js";
import { paymobTransaction } from "../src/testing.js";

const amount = { value: 25000, currency: "EGP" as const };

describe("paymob status mapping (one test per table row)", () => {
  const rows: [string, Parameters<typeof mapPaymobStatus>[0], string][] = [
    ["voided", { success: true, pending: false, is_voided: true }, "canceled"],
    ["void flag on void txn", { success: true, pending: false, is_void: true }, "canceled"],
    ["pending", { success: false, pending: true }, "pending"],
    ["succeeded", { success: true, pending: false, is_refunded: false, is_voided: false }, "succeeded"],
    [
      "partially refunded",
      { success: true, pending: false, is_refunded: true, refunded_amount_cents: 100 },
      "partially_refunded",
    ],
    [
      "fully refunded",
      { success: true, pending: false, is_refunded: true, refunded_amount_cents: 25000 },
      "refunded",
    ],
    ["refunded, amount unknown", { success: true, pending: false, is_refunded: true }, "refunded"],
    ["refund transaction", { success: true, pending: false, is_refund: true }, "refunded"],
    ["failed", { success: false, pending: false }, "failed"],
    ["string booleans", { success: "true" as never, pending: "false" as never }, "succeeded"],
  ];
  for (const [name, txn, status] of rows) {
    it(name, () => expect(mapPaymobStatus(txn, amount)).toBe(status));
  }

  it("table covers every status the mapper can return", () => {
    const tableStatuses = new Set(PAYMOB_STATUS_TABLE.map((r) => r.status));
    for (const [, , status] of rows) expect(tableStatuses.has(status as never)).toBe(true);
  });
});

describe("toPaymobPayment", () => {
  it("normalizes a successful card transaction", () => {
    const p = toPaymobPayment(paymobTransaction(), "EGP");
    expect(p).toMatchObject({
      id: "paymob_192036465",
      providerPaymentId: "192036465",
      reference: "order_8841",
      status: "succeeded",
      amount,
      amountRefunded: { value: 0, currency: "EGP" },
      method: "card",
      card: { last4: "2346", brand: "MasterCard" },
    });
    expect(p.failure).toBeUndefined();
  });

  it("captures failures", () => {
    const p = toPaymobPayment(paymobTransaction({ success: false }), "EGP");
    expect(p.failure).toEqual({ code: "PAYMENT_DECLINED", message: "Approved", providerCode: "APPROVED" });
    const q = toPaymobPayment(paymobTransaction({ success: false, data: undefined }), "EGP");
    expect(q.failure?.message).toBe("Payment failed");
  });

  it("computes refunded amounts", () => {
    expect(
      toPaymobPayment(paymobTransaction({ is_refunded: true, refunded_amount_cents: 10000 }), "EGP")
        .amountRefunded.value,
    ).toBe(10000);
    expect(toPaymobPayment(paymobTransaction({ is_refunded: true }), "EGP").amountRefunded.value).toBe(25000);
    expect(
      toPaymobPayment(paymobTransaction({ is_refund: true, amount_cents: 5000 }), "EGP").amountRefunded.value,
    ).toBe(5000);
  });

  it("falls back on unknown currency, numeric order, special_reference and wallets", () => {
    const p = toPaymobPayment(
      paymobTransaction({
        currency: "XXX",
        order: 55,
        special_reference: "ref_x",
        source_data: { type: "wallet", pan: "01010101010" },
      }),
      "SAR",
    );
    expect(p.amount.currency).toBe("SAR");
    expect(p.reference).toBe("ref_x");
    expect(p.method).toBe("wallet");
    expect(p.card).toBeUndefined();
    expect(orderId(paymobTransaction({ order: 55 }))).toBe("55");
    expect(orderId(paymobTransaction())).toBe("217503754");
    expect(merchantReference(paymobTransaction({ order: undefined, extras: { sarraf_ref: "e" } }))).toBe("e");
    expect(merchantReference(paymobTransaction({ order: undefined }))).toBe("");
  });

  it("maps source types to methods", () => {
    expect(mapPaymobMethod(undefined)).toBeUndefined();
    expect(mapPaymobMethod("CARD")).toBe("card");
    expect(mapPaymobMethod("aggregator")).toBe("cash_outlet");
    expect(mapPaymobMethod("valu")).toBe("installments");
    expect(mapPaymobMethod("something")).toBe("other");
  });
});
