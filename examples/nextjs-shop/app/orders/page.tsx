import { orders } from "../../lib/pay";
import { PROVIDER_INFO, formatMoney, isPending } from "../../lib/shop";
import { AutoRefresh, StatusBadge } from "../components";

export const dynamic = "force-dynamic";

export default function Orders() {
  const list = [...orders.values()].reverse();
  return (
    <>
      <AutoRefresh when={list.some((o) => isPending(o.status))} />
      <h1>Orders</h1>
      <p className="muted">
        Kept in memory for this demo. Status comes from verified webhooks, never from redirects.
      </p>
      <section className="card" style={{ padding: 0, marginTop: 24 }}>
        {list.length === 0 ? (
          <div className="empty muted">
            No orders yet. <a href="/">Buy something</a>.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Provider</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {list.map((o) => (
                  <tr key={o.reference}>
                    <td>
                      <a href={`/orders/${o.reference}`}>{o.reference}</a>
                    </td>
                    <td>{PROVIDER_INFO[o.provider].label}</td>
                    <td>{formatMoney(o.amount)}</td>
                    <td>
                      <StatusBadge status={o.status} />
                    </td>
                    <td className="muted">{new Date(o.createdAt).toLocaleTimeString("en-GB")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
