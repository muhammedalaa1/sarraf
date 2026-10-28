"use client";

import { useCallback, useEffect, useState } from "react";
import type { Order } from "../../lib/orders";

interface ProviderCaps {
  id: string;
  lookup: boolean;
  refund: boolean;
  partialRefund: boolean;
  cancel: boolean;
  capture: boolean;
}

type Action = "reconcile" | "refund" | "cancel" | "capture";

interface ActionResponse {
  ok: boolean;
  input?: unknown;
  order?: Order | undefined;
  result?: ({ raw?: unknown } & Record<string, unknown>) | undefined;
  http?: unknown[] | undefined;
  error?: { code?: string; message: string } | undefined;
}

const KASHIER_FLOW: [string, string][] = [
  ["1. Create link", "Playground → provider kashier → Create checkout."],
  ["2. Pay", "Open the hosted page and pay with a Kashier test card."],
  ["3. Reconcile", "Reads the order by reference and fills in Kashier's order id, which refunds need."],
  ["4. Refund", "Partial: enter an amount. Full: leave it blank and Sarraf refunds what is left."],
  ["5. Void", "Same day only, on a paid order with no refunds. After that, refund instead."],
];

const PAYMOB_FLOW: [string, string][] = [
  ["1. Create", "Playground → provider paymob → Create checkout (card, wallet, or card (authorize only))."],
  ["2. Pay", "Card 5123 4567 8901 2346, 01/39, CVV 123. Wallet 01010101010, MPin and OTP 123456."],
  [
    "3. Reconcile",
    "Fills in the transaction id from the webhook or a lookup; refunds, voids and captures need it.",
  ],
  ["4. Capture", "Authorize-only orders: capture the full amount (blank) or part of it."],
  ["5. Refund", "Partial: enter an amount. Full: leave it blank and Sarraf refunds what is left."],
  ["6. Void", "Same business day only, before settlement. After that, refund instead."],
];

const FLOWS: { provider: string; title: string; steps: [string, string][]; note: React.ReactNode }[] = [
  {
    provider: "kashier",
    title: "Kashier test flow",
    steps: KASHIER_FLOW,
    note: (
      <>
        Lookups, refunds and voids need <span className="code">KASHIER_SECRET_KEY</span>.
      </>
    ),
  },
  {
    provider: "paymob",
    title: "Paymob test flow",
    steps: PAYMOB_FLOW,
    note: (
      <>
        Lookups and full refunds need <span className="code">PAYMOB_API_KEY</span>; manual capture needs{" "}
        <span className="code">PAYMOB_CARD_AUTH_INTEGRATION_ID</span>.
      </>
    ),
  },
];

export function Operations({ providers, demo }: { providers: ProviderCaps[]; demo: boolean }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [last, setLast] = useState<{ title: string; res: ActionResponse } | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [lookupProvider, setLookupProvider] = useState(
    providers.find((p) => p.id === "kashier")?.id ?? providers[0]?.id ?? "",
  );
  const [lookupRef, setLookupRef] = useState("");
  const caps = (id: string) => providers.find((p) => p.id === id);

  const load = useCallback(async () => {
    const res = await fetch("/api/orders", { cache: "no-store" });
    if (res.ok) setOrders(await res.json());
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  async function run(action: Action, o: { provider: string; reference: string }, amount?: string) {
    const key = `${o.provider}:${o.reference}`;
    setBusy(`${key}:${action}`);
    try {
      const res = await fetch("/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, provider: o.provider, reference: o.reference, amount }),
      });
      const data = (await res.json()) as ActionResponse;
      setLast({ title: `${action} · ${o.provider} · ${o.reference}`, res: data });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function remove(o: Order) {
    await fetch(`/api/orders?provider=${o.provider}&reference=${encodeURIComponent(o.reference)}`, {
      method: "DELETE",
    });
    await load();
  }

  async function clear() {
    await fetch("/api/orders", { method: "DELETE" });
    await load();
  }

  return (
    <>
      {FLOWS.filter((f) => caps(f.provider)).map((f) => (
        <details className="card" key={f.provider}>
          <summary>
            <strong>{f.title}</strong>
          </summary>
          <div className="table-wrap">
            <table>
              <tbody>
                {f.steps.map(([step, how]) => (
                  <tr key={step}>
                    <td>
                      <strong>{step}</strong>
                    </td>
                    <td className="muted">{how}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">
            {f.note} Webhooks reach the inbox only through a public URL: set{" "}
            <span className="code">SANDBOX_PUBLIC_URL</span> to your tunnel.
            {demo && " Demo mode: providers are fake and every checkout is marked paid straight away."}
          </p>
        </details>
      ))}

      <form
        className="card inline"
        onSubmit={(e) => {
          e.preventDefault();
          if (lookupRef.trim())
            void run("reconcile", { provider: lookupProvider, reference: lookupRef.trim() });
        }}
      >
        <label>
          Provider
          <select value={lookupProvider} onChange={(e) => setLookupProvider(e.target.value)}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id}
              </option>
            ))}
          </select>
        </label>
        <label style={{ flex: 1, minWidth: 220 }}>
          Reference (merchant order id)
          <input value={lookupRef} onChange={(e) => setLookupRef(e.target.value)} placeholder="sbx_…" />
        </label>
        <button type="submit" disabled={!lookupRef.trim() || busy !== null || !caps(lookupProvider)?.lookup}>
          Look up / reconcile
        </button>
      </form>

      <div className="card">
        <div className="row">
          <strong>Orders</strong>
          <button className="secondary" type="button" onClick={clear} disabled={orders.length === 0}>
            Clear list
          </button>
        </div>
        {orders.length === 0 ? (
          <p className="muted">
            No orders yet. Create one in the <a href="/">playground</a> or look one up above.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Status</th>
                  <th>Amount</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const c = caps(o.provider);
                  const p = o.payment;
                  const amount = amounts[o.key] ?? "";
                  return (
                    <tr key={o.key}>
                      <td>
                        <span className="pill">{o.provider}</span> <span className="code">{o.reference}</span>
                        {p?.providerPaymentId && p.providerPaymentId !== o.reference && (
                          <div className="muted code">id {p.providerPaymentId}</div>
                        )}
                        <div className="muted">{new Date(o.createdAt).toLocaleString()}</div>
                        {o.redirectUrl && (
                          <a href={o.redirectUrl} target="_blank" rel="noreferrer">
                            open checkout ↗
                          </a>
                        )}
                        {o.referenceCode && <div className="code">code {o.referenceCode}</div>}
                      </td>
                      <td>
                        <span className={`pill status-${p?.status ?? "unknown"}`}>
                          {p?.status ?? "unknown"}
                        </span>
                        {o.history[0] && (
                          <div className={o.history[0].ok ? "muted" : "bad"}>
                            {o.history[0].action}: {o.history[0].summary}
                          </div>
                        )}
                        {o.history.length > 1 && (
                          <details>
                            <summary className="muted">history ({o.history.length})</summary>
                            <ul className="history">
                              {o.history.map((h) => (
                                <li key={`${h.at}${h.action}`} className={h.ok ? "" : "bad"}>
                                  <span className="muted">{new Date(h.at).toLocaleTimeString()}</span>{" "}
                                  {h.action}: {h.summary}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </td>
                      <td className="code">
                        {formatMoney(p?.amount ?? o.amount)}
                        {p && p.amountRefunded.value > 0 && (
                          <div className="muted">refunded {formatMoney(p.amountRefunded)}</div>
                        )}
                      </td>
                      <td>
                        <OrderActions
                          order={o}
                          caps={c}
                          busy={busy}
                          amount={amount}
                          onAmount={(v) => setAmounts({ ...amounts, [o.key]: v })}
                          run={run}
                          remove={remove}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {last && (
        <>
          <div className="card">
            <strong>{last.title}</strong>{" "}
            {last.res.ok ? (
              <span className="ok">✓ ok</span>
            ) : (
              <span className="bad">
                ✗ {last.res.error?.code ?? "ERROR"}: {last.res.error?.message}
              </span>
            )}
          </div>
          <div className="grid">
            <div className="card">
              <strong>Requests (redacted)</strong>
              <pre>{JSON.stringify(last.res.http?.length ? last.res.http : last.res.input, null, 2)}</pre>
            </div>
            <div className="card">
              <strong>Raw response</strong>
              <pre>{JSON.stringify(last.res.result?.raw ?? last.res.error ?? null, null, 2)}</pre>
            </div>
            <div className="card">
              <strong>Normalized</strong>
              <pre>
                {JSON.stringify(last.res.result ? { ...last.res.result, raw: undefined } : null, null, 2)}
              </pre>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function OrderActions({
  order: o,
  caps: c,
  busy,
  amount,
  onAmount,
  run,
  remove,
}: {
  order: Order;
  caps: ProviderCaps | undefined;
  busy: string | null;
  amount: string;
  onAmount: (value: string) => void;
  run: (action: Action, o: Order, amount?: string) => Promise<void>;
  remove: (o: Order) => Promise<void>;
}) {
  const label = (a: Action, text: string) => (busy === `${o.key}:${a}` ? "…" : text);
  const authorized = c?.capture && o.payment?.status === "requires_action";
  return (
    <div className="actions">
      <button
        type="button"
        className="secondary"
        disabled={!c?.lookup || busy !== null}
        onClick={() => run("reconcile", o)}
      >
        {label("reconcile", "Reconcile")}
      </button>
      <input
        aria-label="Amount"
        placeholder={c?.partialRefund ? "full" : "full only"}
        disabled={!c?.partialRefund && !authorized}
        inputMode="decimal"
        value={amount}
        onChange={(e) => onAmount(e.target.value)}
      />
      {authorized && (
        <button type="button" disabled={busy !== null} onClick={() => run("capture", o, amount || undefined)}>
          {label("capture", amount ? `Capture ${amount}` : "Capture")}
        </button>
      )}
      <button
        type="button"
        disabled={!c?.refund || busy !== null}
        onClick={() => run("refund", o, amount || undefined)}
      >
        {label("refund", amount ? `Refund ${amount}` : "Full refund")}
      </button>
      <button
        type="button"
        className="danger"
        disabled={!c?.cancel || busy !== null}
        onClick={() => run("cancel", o)}
      >
        {label("cancel", "Void")}
      </button>
      <button type="button" className="secondary" onClick={() => remove(o)} title="Forget">
        ✕
      </button>
    </div>
  );
}

function formatMoney(m: { value: number; currency: string } | undefined) {
  if (!m) return "—";
  return `${(m.value / 100).toFixed(2)} ${m.currency}`;
}
