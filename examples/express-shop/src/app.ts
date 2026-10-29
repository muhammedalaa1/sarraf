import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isSarrafError,
  type Money,
  type PaymentStatus,
  type ProviderId,
  type Sarraf,
  type SarrafEvent,
} from "@sarrafjs/core";
import { rawBody, webhookHandler } from "@sarrafjs/express";
import type { FakeProvider } from "@sarrafjs/testing";
import express from "express";
import * as views from "./views.js";

export interface Order {
  reference: string;
  provider: ProviderId;
  quantity: number;
  amount: Money;
  refunded: Money;
  status: PaymentStatus;
  providerPaymentId?: string | undefined;
  referenceCode?: string | undefined;
  expiresAt?: string | undefined;
  createdAt: number;
}

/** A tiny in-memory "database". Use your real DB and a unique index on event id. */
export class Store {
  orders = new Map<string, Order>();
  processedEvents = new Set<string>();
}

/** The one place order state changes: a verified, deduplicated webhook event. */
export function applyEvent(store: Store, event: SarrafEvent): void {
  if (store.processedEvents.has(event.id)) return; // dedupe: providers retry
  store.processedEvents.add(event.id);
  if (event.type === "card.saved") return; // this shop does not keep saved cards
  const order = store.orders.get(event.payment.reference);
  if (!order) return;
  order.status = event.payment.status;
  order.refunded = event.payment.amountRefunded;
  order.providerPaymentId ??= event.payment.providerPaymentId;
}

export interface AppOptions {
  store?: Store | undefined;
  /** Public base URL of this shop, used for return and webhook URLs. */
  publicUrl?: string | undefined;
  /** Fake providers: enables the fake hosted checkout pages under /demo. */
  demo?: boolean | undefined;
}

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "../public");
const MAX_QUANTITY = 5;

export function createApp(pay: Sarraf, options: AppOptions = {}) {
  const store = options.store ?? new Store();
  const publicUrl = options.publicUrl ?? "http://localhost:3000";
  const demo = options.demo ?? false;
  const app = express();

  // ── Webhooks: raw body, verified, deduped. Mounted before any body parser. ──────────────
  app.post(
    "/api/webhooks/:provider",
    rawBody(),
    webhookHandler(pay, (event) => applyEvent(store, event)),
  );

  app.use("/static", express.static(PUBLIC_DIR));
  app.use(express.urlencoded({ extended: false }));

  app.get("/", (_req, res) => {
    res.type("html").send(views.home({ demo, providers: pay.providerIds }));
  });

  // ── Checkout ────────────────────────────────────────────────────────────────────────────
  app.post("/checkout", async (req, res) => {
    const provider = String(req.body.provider) as ProviderId;
    const quantity = Math.min(Math.max(Number.parseInt(String(req.body.quantity), 10) || 1, 1), MAX_QUANTITY);
    const phone = String(req.body.phone ?? "");
    const unit = views.PRODUCT.price;
    const amount: Money = { value: unit.value * quantity, currency: unit.currency };
    const reference = `order_${Date.now()}`;
    try {
      const checkout = await pay.checkout.create({
        provider,
        amount,
        reference,
        customer: { phone },
        items: [{ name: views.PRODUCT.name, unitAmount: unit, quantity }],
        returnUrl: `${publicUrl}/thanks/${provider}`,
        webhookUrl: `${publicUrl}/api/webhooks/${provider}`,
        idempotencyKey: reference,
      });
      store.orders.set(reference, {
        reference,
        provider,
        quantity,
        amount,
        refunded: { value: 0, currency: amount.currency },
        status: checkout.payment.status,
        providerPaymentId: checkout.payment.providerPaymentId,
        referenceCode: checkout.referenceCode,
        expiresAt: checkout.expiresAt,
        createdAt: Date.now(),
      });
      // Card / wallet: the provider's hosted page. Fawry cash: our page showing the code.
      res.redirect(303, checkout.redirectUrl ?? `/orders/${reference}`);
    } catch (err) {
      res
        .status(400)
        .type("html")
        .send(
          views.home({
            demo,
            providers: pay.providerIds,
            error: errorMessage(err),
            values: { provider, quantity, phone },
          }),
        );
    }
  });

  // ── Return from the provider: redirect params are for UX only ───────────────────────────
  app.get("/thanks/:provider", async (req, res) => {
    const provider = req.params.provider as ProviderId;
    const query = req.query as Record<string, string>;
    let reference = query.reference;
    let declined = false;
    try {
      const r = await pay.redirects.verify(provider, query);
      reference = r.reference ?? reference;
      declined = r.authenticated && r.status === "failed";
    } catch {
      // Not every provider signs redirects. The webhook remains the source of truth.
    }
    const order = reference ? store.orders.get(reference) : undefined;
    if (!order) return void res.status(404).type("html").send(views.notFound(demo));
    res.type("html").send(
      views.order({
        demo,
        order,
        ...(declined
          ? { error: "The payment did not go through. You can try again from the shop." }
          : order.status === "succeeded"
            ? { notice: "Thanks! Your payment is confirmed." }
            : { notice: "Thanks! Your order is confirmed as soon as the provider notifies us." }),
      }),
    );
  });

  // ── Orders ──────────────────────────────────────────────────────────────────────────────
  app.get("/orders", (_req, res) => {
    res.type("html").send(views.orders({ demo, orders: [...store.orders.values()].reverse() }));
  });

  app.get("/orders.json", (_req, res) => {
    res.json([...store.orders.values()]);
  });

  app.get("/orders/:reference", (req, res) => {
    const order = store.orders.get(req.params.reference);
    if (!order) return void res.status(404).type("html").send(views.notFound(demo));
    res.type("html").send(views.order({ demo, order }));
  });

  // Webhooks get lost: ask the provider directly. Also runs on a schedule (reconcilePending).
  app.post("/orders/:reference/reconcile", async (req, res) => {
    const order = store.orders.get(req.params.reference);
    if (!order) return void res.status(404).type("html").send(views.notFound(demo));
    try {
      const payment = await pay.payments.reconcile({ provider: order.provider, reference: order.reference });
      order.status = payment.status;
      order.refunded = payment.amountRefunded;
      res.type("html").send(views.order({ demo, order, notice: `Provider says: ${payment.status}.` }));
    } catch (err) {
      res
        .status(400)
        .type("html")
        .send(views.order({ demo, order, error: errorMessage(err) }));
    }
  });

  app.post("/orders/:reference/refund", async (req, res) => {
    const order = store.orders.get(req.params.reference);
    if (!order) return void res.status(404).type("html").send(views.notFound(demo));
    try {
      if (!order.providerPaymentId) throw new Error("This order has no provider payment id yet.");
      const refund = await pay.refunds.create({
        provider: order.provider,
        providerPaymentId: order.providerPaymentId,
        reference: order.reference,
        idempotencyKey: `refund:${order.reference}`, // a double click cannot refund twice
      });
      if (refund.payment) {
        order.status = refund.payment.status;
        order.refunded = refund.payment.amountRefunded;
      }
      res.type("html").send(views.order({ demo, order, notice: `Refund ${refund.status}.` }));
    } catch (err) {
      res
        .status(400)
        .type("html")
        .send(views.order({ demo, order, error: errorMessage(err) }));
    }
  });

  // ── Demo mode only: stand-ins for the provider's side ──────────────────────────────────
  if (demo) {
    const fake = (provider: ProviderId) => pay.provider(provider) as unknown as FakeProvider<ProviderId>;

    // The "hosted checkout" a fake redirect points at.
    app.get("/demo/pay/:providerPaymentId", (req, res) => {
      const order = store.orders.get(String(req.query.reference));
      if (!order) return void res.status(404).type("html").send(views.notFound(demo));
      res.type("html").send(views.fakeCheckout({ order }));
    });

    // The provider decides, sends a signed webhook (verified like a real one), then redirects back.
    app.post("/demo/pay/:reference", async (req, res) => {
      const order = store.orders.get(req.params.reference);
      if (!order) return void res.status(404).type("html").send(views.notFound(demo));
      const outcome = req.body.outcome === "failed" ? "failed" : "succeeded";
      const webhook = fake(order.provider).simulate(order.reference, outcome);
      applyEvent(store, await pay.webhooks.verifyAndParse(order.provider, webhook));
      res.redirect(303, `/thanks/${order.provider}?reference=${encodeURIComponent(order.reference)}`);
    });

    // A customer paying a Fawry code at an outlet.
    app.post("/demo/fawry/:reference", async (req, res) => {
      const order = store.orders.get(req.params.reference);
      if (!order) return void res.status(404).type("html").send(views.notFound(demo));
      const webhook = fake(order.provider).simulate(order.reference, "succeeded");
      applyEvent(store, await pay.webhooks.verifyAndParse(order.provider, webhook));
      res.redirect(303, `/orders/${encodeURIComponent(order.reference)}`);
    });
  }

  return app;
}

function errorMessage(err: unknown): string {
  if (isSarrafError(err)) return err.message;
  return err instanceof Error ? err.message : "Something went wrong.";
}

/** Re-check orders still pending after `olderThanMs`. Run on a schedule (e.g. every 5 minutes). */
export async function reconcilePending(pay: Sarraf, store: Store, olderThanMs = 15 * 60 * 1000) {
  const now = Date.now();
  for (const order of store.orders.values()) {
    if (!views.isPending(order.status) || now - order.createdAt < olderThanMs) continue;
    try {
      const p = await pay.payments.reconcile({ provider: order.provider, reference: order.reference });
      order.status = p.status;
      order.refunded = p.amountRefunded;
    } catch {
      // keep it pending; try again next run
    }
  }
}
