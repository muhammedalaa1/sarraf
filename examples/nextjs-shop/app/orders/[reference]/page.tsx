import { notFound } from "next/navigation";
import { getPay, orders } from "../../../lib/pay";
import { PRODUCT, PROVIDER_INFO, formatMoney, headline, isPending } from "../../../lib/shop";
import { demoPayAtOutlet, reconcile, refund } from "../../actions";
import { AutoRefresh, Notice, StatusBadge } from "../../components";

export const dynamic = "force-dynamic";

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ reference: string }>;
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const { reference } = await params;
  const { notice, error } = await searchParams;
  const order = orders.get(reference);
  if (!order) notFound();
  const { demo } = getPay();
  const pending = isPending(order.status);
  const refundable = order.status === "succeeded" || order.status === "partially_refunded";
  const provider = PROVIDER_INFO[order.provider].label;

  return (
    <div className="stack" style={{ maxWidth: 560 }}>
      <AutoRefresh when={pending} />
      <div>
        <p className="muted small">
          <a href="/orders">← Orders</a>
        </p>
        <h1>{headline(order.status)}</h1>
        <p className="muted">
          {PRODUCT.name} × {order.quantity}
        </p>
      </div>
      <Notice text={notice} tone="ok" />
      <Notice text={error} tone="bad" />

      {order.referenceCode && pending && (
        <section className="card stack">
          <h2>Pay at any Fawry outlet or in the Fawry app</h2>
          <div className="code">{order.referenceCode}</div>
          <p className="muted small">
            Give this code and {formatMoney(order.amount)}
            {order.expiresAt && <> before {new Date(order.expiresAt).toLocaleString("en-GB")}</>}. This page
            updates when Fawry confirms.
          </p>
          {demo && (
            <form action={demoPayAtOutlet.bind(null, order.reference)}>
              <button className="secondary" type="submit">
                Demo: simulate paying at an outlet
              </button>
            </form>
          )}
        </section>
      )}

      <section className="card stack">
        <dl>
          <dt>Status</dt>
          <dd>
            <StatusBadge status={order.status} />
          </dd>
          <dt>Amount</dt>
          <dd>{formatMoney(order.amount)}</dd>
          {order.refunded.value > 0 && (
            <>
              <dt>Refunded</dt>
              <dd>{formatMoney(order.refunded)}</dd>
            </>
          )}
          <dt>Provider</dt>
          <dd>{provider}</dd>
          <dt>Reference</dt>
          <dd>
            <code>{order.reference}</code>
          </dd>
        </dl>
        {pending && (
          <p className="muted small">
            Status changes only when a verified webhook arrives. This page refreshes itself.
          </p>
        )}
        <div className="actions">
          <form action={reconcile.bind(null, order.reference)}>
            <button className="secondary" type="submit">
              Check status with {provider}
            </button>
          </form>
          {refundable && (
            <form action={refund.bind(null, order.reference)}>
              <button className="secondary" type="submit">
                Refund
              </button>
            </form>
          )}
        </div>
      </section>
    </div>
  );
}
