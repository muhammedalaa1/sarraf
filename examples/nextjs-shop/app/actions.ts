"use server";

import { isSarrafError, type Money, type ProviderId } from "@sarraf/core";
import type { FakeProvider } from "@sarraf/testing";
import { redirect } from "next/navigation";
import { applyEvent, getPay, orders, PUBLIC_URL } from "../lib/pay";
import { MAX_QUANTITY, PRODUCT } from "../lib/shop";

const message = (err: unknown) =>
  isSarrafError(err) ? err.message : err instanceof Error ? err.message : "Something went wrong.";

const withParam = (path: string, key: "notice" | "error", value: string) =>
  `${path}?${new URLSearchParams({ [key]: value })}`;

// ── Checkout ──────────────────────────────────────────────────────────────────────────────
export async function checkout(formData: FormData) {
  const { pay } = getPay();
  const provider = String(formData.get("provider")) as ProviderId;
  const quantity = Math.min(Math.max(Number(formData.get("quantity")) || 1, 1), MAX_QUANTITY);
  const unit = PRODUCT.price;
  const amount: Money = { value: unit.value * quantity, currency: unit.currency };
  const reference = `order_${Date.now()}`;

  let destination: string;
  try {
    const result = await pay.checkout.create({
      provider,
      amount,
      reference,
      customer: { phone: String(formData.get("phone") ?? "") },
      items: [{ name: PRODUCT.name, unitAmount: unit, quantity }],
      returnUrl: `${PUBLIC_URL}/thanks/${provider}`,
      webhookUrl: `${PUBLIC_URL}/api/webhooks/${provider}`,
      idempotencyKey: reference,
    });
    orders.set(reference, {
      reference,
      provider,
      quantity,
      amount,
      refunded: { value: 0, currency: amount.currency },
      status: result.payment.status,
      providerPaymentId: result.payment.providerPaymentId,
      referenceCode: result.referenceCode,
      expiresAt: result.expiresAt,
      createdAt: Date.now(),
    });
    // Card / wallet: the provider's hosted page. Fawry cash: our page showing the code.
    destination = result.redirectUrl ?? `/orders/${reference}`;
  } catch (err) {
    destination = withParam("/", "error", message(err));
  }
  redirect(destination); // outside try: redirect() works by throwing
}

// ── After-sale actions ────────────────────────────────────────────────────────────────────
/** Webhooks get lost: ask the provider directly. Run this on a schedule too. */
export async function reconcile(reference: string) {
  const { pay } = getPay();
  const order = orders.get(reference);
  if (!order) redirect("/orders");
  let destination: string;
  try {
    const payment = await pay.payments.reconcile({ provider: order.provider, reference });
    order.status = payment.status;
    order.refunded = payment.amountRefunded;
    destination = withParam(`/orders/${reference}`, "notice", `Provider says: ${payment.status}.`);
  } catch (err) {
    destination = withParam(`/orders/${reference}`, "error", message(err));
  }
  redirect(destination);
}

export async function refund(reference: string) {
  const { pay } = getPay();
  const order = orders.get(reference);
  if (!order) redirect("/orders");
  let destination: string;
  try {
    if (!order.providerPaymentId) throw new Error("This order has no provider payment id yet.");
    const result = await pay.refunds.create({
      provider: order.provider,
      providerPaymentId: order.providerPaymentId,
      reference,
      idempotencyKey: `refund:${reference}`, // a double click cannot refund twice
    });
    if (result.payment) {
      order.status = result.payment.status;
      order.refunded = result.payment.amountRefunded;
    }
    destination = withParam(`/orders/${reference}`, "notice", `Refund ${result.status}.`);
  } catch (err) {
    destination = withParam(`/orders/${reference}`, "error", message(err));
  }
  redirect(destination);
}

// ── Demo mode only: stand-ins for the provider's side ────────────────────────────────────
async function simulate(reference: string, outcome: "succeeded" | "failed") {
  const { pay, demo } = getPay();
  const order = orders.get(reference);
  if (!demo || !order) redirect("/orders");
  const fake = pay.provider(order.provider) as unknown as FakeProvider<ProviderId>;
  // The provider sends a signed webhook; it is verified exactly like a real one.
  applyEvent(await pay.webhooks.verifyAndParse(order.provider, fake.simulate(reference, outcome)));
  return order;
}

export async function demoPay(reference: string, formData: FormData) {
  const order = await simulate(reference, formData.get("outcome") === "failed" ? "failed" : "succeeded");
  redirect(`/thanks/${order.provider}?${new URLSearchParams({ reference })}`);
}

export async function demoPayAtOutlet(reference: string) {
  await simulate(reference, "succeeded");
  redirect(`/orders/${reference}`);
}
