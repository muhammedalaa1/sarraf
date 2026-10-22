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
} from "@sarraf/core";
import { type Order, type Orders, withoutRaw } from "./orders";

export interface ActionBody {
  action: "reconcile" | "refund" | "cancel";
  provider: ProviderId;
  reference: string;
  /** Provider's own payment / order id. Taken from the stored order when omitted. */
  providerPaymentId?: string | undefined;
  /** Major units, e.g. "50.00". Blank = full refund. */
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
 * - cancel: `payments.cancel` (Kashier: same-day void)
 */
export async function runAction(pay: Sarraf, store: Orders, body: ActionBody): Promise<ActionResult> {
  const { provider, reference } = body;
  if (!provider || !reference?.trim()) {
    return { ok: false, error: { code: "INVALID_REQUEST", message: "provider and reference are required" } };
  }
  const known = store.get(provider, reference);
  const providerPaymentId = body.providerPaymentId?.trim() || known?.payment?.providerPaymentId;
  try {
    if (body.action === "reconcile") {
      const payment = await pay.payments.reconcile({ provider, reference });
      const order = store.upsert(
        provider,
        reference,
        { payment: withoutRaw(payment), amount: known?.amount ?? payment.amount },
        { action: "reconcile", ok: true, summary: statusLine(payment) },
      );
      return { ok: true, order, result: payment };
    }

    if (body.action === "refund") {
      if (!providerPaymentId) {
        throw new Error("No provider payment id yet: reconcile the order after paying it, or enter the id.");
      }
      const currency = known?.payment?.amount.currency ?? known?.amount?.currency ?? "EGP";
      const amount = body.amount?.trim()
        ? { value: toMinor(body.amount.trim(), currency), currency }
        : undefined;
      const refund = await pay.refunds.create({
        provider,
        providerPaymentId,
        reference,
        amount,
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
    }

    if (body.action === "cancel") {
      const payment = await pay.payments.cancel({ provider, reference, providerPaymentId });
      const order = store.upsert(
        provider,
        reference,
        { payment: withoutRaw(payment) },
        { action: "cancel", ok: true, summary: `void · ${statusLine(payment)}` },
      );
      return { ok: true, order, result: payment };
    }

    return {
      ok: false,
      error: { code: "INVALID_REQUEST", message: `unknown action "${String(body.action)}"` },
    };
  } catch (err) {
    const error = toErrorJson(err);
    // SarrafError messages already start with "<CODE>: ".
    const summary = error.code ? error.message : `ERROR: ${error.message}`;
    const order = store.upsert(provider, reference, {}, { action: body.action, ok: false, summary });
    return { ok: false, order, error };
  }
}

/**
 * `instanceof SarrafError` fails when Next bundles the adapters with their own copy of
 * `@sarraf/core`, so fall back to the error's name.
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
