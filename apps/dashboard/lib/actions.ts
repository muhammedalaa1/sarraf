import {
  isSarrafError,
  type Money,
  type Payment,
  type ProviderId,
  type Refund,
  type Sarraf,
  type SarrafError,
  toMajorString,
  toMinor,
} from "@sarrafjs/core";
import { type Order, type Orders, withoutRaw } from "./orders";

export interface ActionBody {
  action: "reconcile" | "refund" | "cancel" | "capture";
  provider: ProviderId;
  reference: string;
  /** Provider's own payment / order id. Taken from the stored order when omitted. */
  providerPaymentId?: string | undefined;
  /** Major units, e.g. "50.00". Blank = full refund / full capture. */
  amount?: string | undefined;
  reason?: string | undefined;
}

export interface ActionResult {
  ok: boolean;
  order?: Order | undefined;
  result?: Payment | Refund | undefined;
  error?: { code?: string; message: string } | undefined;
}

/**
 * Runs one post-checkout operation and records it on the order:
 * - reconcile: `payments.reconcile` (status lookup by reference)
 * - refund: `refunds.create`, full when `amount` is blank, then reconciles the order
 * - cancel: `payments.cancel` (Kashier / Paymob: same-day void)
 * - capture: `payments.capture`, full when `amount` is blank (Paymob manual capture)
 */
export async function runAction(pay: Sarraf, store: Orders, body: ActionBody): Promise<ActionResult> {
  const { provider, reference } = body;
  if (!provider || !reference?.trim()) {
    return { ok: false, error: { code: "INVALID_REQUEST", message: "provider and reference are required" } };
  }
  const handler = HANDLERS[body.action];
  if (!handler) {
    return {
      ok: false,
      error: { code: "INVALID_REQUEST", message: `unknown action "${String(body.action)}"` },
    };
  }
  const known = store.get(provider, reference);
  const call: ActionCall = {
    pay,
    store,
    body,
    provider,
    reference,
    known,
    providerPaymentId: body.providerPaymentId?.trim() || known?.payment?.providerPaymentId || undefined,
  };
  try {
    return await handler(call);
  } catch (err) {
    const error = toErrorJson(err);
    // SarrafError messages already start with "<CODE>: ".
    const summary = error.code ? error.message : `ERROR: ${error.message}`;
    const order = store.upsert(provider, reference, {}, { action: body.action, ok: false, summary });
    return { ok: false, order, error };
  }
}

interface ActionCall {
  pay: Sarraf;
  store: Orders;
  body: ActionBody;
  provider: ProviderId;
  reference: string;
  known: Order | undefined;
  providerPaymentId: string | undefined;
}

const HANDLERS: Record<ActionBody["action"], (c: ActionCall) => Promise<ActionResult>> = {
  async reconcile({ pay, store, provider, reference, known }) {
    const payment = await pay.payments.reconcile({ provider, reference });
    const order = store.upsert(
      provider,
      reference,
      { payment: withoutRaw(payment), amount: known?.amount ?? payment.amount },
      { action: "reconcile", ok: true, summary: statusLine(payment) },
    );
    return { ok: true, order, result: payment };
  },

  async refund({ pay, store, body, provider, reference, known, providerPaymentId }) {
    const refund = await pay.refunds.create({
      provider,
      providerPaymentId: requireId(providerPaymentId, "paying"),
      reference,
      amount: amountOf(body, known),
      reason: body.reason || undefined,
      idempotencyKey: `dash_${reference}_${Date.now()}`,
    });
    const after = await pay.payments.reconcile({ provider, reference }).catch(() => refund.payment);
    const order = store.upsert(
      provider,
      reference,
      { payment: after ? withoutRaw(after) : known?.payment },
      {
        action: "refund",
        ok: refund.status !== "failed",
        summary: `refund ${refund.status}${refund.amount ? ` · ${fmt(refund.amount)}` : ""}`,
      },
    );
    return { ok: refund.status !== "failed", order, result: refund };
  },

  async capture({ pay, store, body, provider, reference, known, providerPaymentId }) {
    const payment = await pay.payments.capture({
      provider,
      providerPaymentId: requireId(providerPaymentId, "authorizing"),
      reference,
      amount: amountOf(body, known),
    });
    const order = store.upsert(
      provider,
      reference,
      { payment: withoutRaw(payment) },
      { action: "capture", ok: true, summary: `capture · ${statusLine(payment)}` },
    );
    return { ok: true, order, result: payment };
  },

  async cancel({ pay, store, provider, reference, providerPaymentId }) {
    const payment = await pay.payments.cancel({ provider, reference, providerPaymentId });
    const order = store.upsert(
      provider,
      reference,
      { payment: withoutRaw(payment) },
      { action: "cancel", ok: true, summary: `void · ${statusLine(payment)}` },
    );
    return { ok: true, order, result: payment };
  },
};

function requireId(providerPaymentId: string | undefined, after: string): string {
  if (!providerPaymentId) {
    throw new Error(`No provider payment id yet: reconcile the order after ${after} it, or enter the id.`);
  }
  return providerPaymentId;
}

/** `body.amount` (major units) in the order's currency; undefined means the full amount. */
function amountOf(body: ActionBody, known: Order | undefined): Money | undefined {
  const major = body.amount?.trim();
  if (!major) return undefined;
  const currency = known?.payment?.amount.currency ?? known?.amount?.currency ?? "EGP";
  return { value: toMinor(major, currency), currency };
}

/**
 * `instanceof SarrafError` fails when Next bundles the adapters with their own copy of
 * `@sarrafjs/core`, so fall back to the error's name.
 */
function toErrorJson(err: unknown): { code?: string; message: string } {
  if (isSarrafError(err) || (err instanceof Error && err.name === "SarrafError" && "toJSON" in err)) {
    return (err as SarrafError).toJSON() as { code?: string; message: string };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}

function statusLine(p: Payment): string {
  return `${p.status} · ${fmt(p.amount)}${p.amountRefunded.value ? ` (refunded ${fmt(p.amountRefunded)})` : ""}`;
}

function fmt(m: Money): string {
  return `${toMajorString(m.value, m.currency)} ${m.currency}`;
}
