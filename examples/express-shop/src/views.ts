/**
 * HTML for the example shop. Kept apart from app.ts so the payment code stays easy to read.
 * Every interpolated value is HTML-escaped by the `html` tag.
 */
import { type Money, type PaymentStatus, type ProviderId, toMajorString } from "@sarrafjs/core";
import type { Order } from "./app.js";

class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function render(value: unknown): string {
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  if (value === undefined || value === null || value === false) return "";
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? "";
  values.forEach((v, i) => {
    out += render(v) + (strings[i + 1] ?? "");
  });
  return new Html(out);
}

export const PRODUCT = {
  name: "Field Notes, pack of 3",
  description: "Pocket notebooks with 48 dot-grid pages each.",
  price: { value: 250_00, currency: "EGP" } satisfies Money,
};

export const PROVIDER_INFO: Record<ProviderId, { label: string; detail: string }> = {
  paymob: { label: "Paymob", detail: "Card or mobile wallet" },
  kashier: { label: "Kashier", detail: "Card or mobile wallet" },
  fawry: { label: "Fawry", detail: "Pay cash at any Fawry outlet" },
};

export const formatMoney = (m: Money): string => `${m.currency} ${toMajorString(m.value, m.currency)}`;

const PENDING: PaymentStatus[] = ["pending", "requires_action", "awaiting_payment"];
export const isPending = (status: PaymentStatus): boolean => PENDING.includes(status);

const HEADLINES: Record<PaymentStatus, string> = {
  pending: "Waiting for payment",
  requires_action: "Waiting for payment",
  awaiting_payment: "Waiting for payment",
  succeeded: "Payment received",
  failed: "Payment failed",
  canceled: "Order canceled",
  expired: "Payment expired",
  refunded: "Refunded",
  partially_refunded: "Partially refunded",
};
export const headline = (status: PaymentStatus): string => HEADLINES[status];

function badge(status: PaymentStatus): Html {
  const tone =
    status === "succeeded"
      ? "ok"
      : status === "failed" || status === "expired" || status === "canceled"
        ? "bad"
        : isPending(status)
          ? "wait"
          : "";
  return html`<span class="badge ${tone}">${status.replace("_", " ")}</span>`;
}

interface Chrome {
  demo: boolean;
  nav?: "shop" | "orders" | undefined;
  refreshSeconds?: number | undefined;
}

function page(title: string, body: Html, chrome: Chrome): string {
  const current = (n: Chrome["nav"]) => (chrome.nav === n ? html` aria-current="page"` : "");
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${chrome.refreshSeconds ? html`<meta http-equiv="refresh" content="${chrome.refreshSeconds}">` : ""}
  <title>${title} · Sarraf shop</title>
  <link rel="stylesheet" href="/static/style.css">
</head>
<body>
  ${chrome.demo ? html`<div class="banner">Demo mode: fake providers, no real money. Add sandbox keys to use real ones.</div>` : ""}
  <header><div class="wrap">
    <a class="brand" href="/">Sarraf shop</a>
    <nav><a href="/"${current("shop")}>Shop</a><a href="/orders"${current("orders")}>Orders</a></nav>
  </div></header>
  <main><div class="wrap">${body}</div></main>
</body>
</html>`.value;
}

function notice(text: string | undefined, tone: "ok" | "bad" | "" = ""): Html | "" {
  return text ? html`<output class="notice ${tone}">${text}</output>` : "";
}

export function home(opts: {
  demo: boolean;
  providers: ProviderId[];
  error?: string | undefined;
  values?: { provider?: string | undefined; quantity?: number | undefined; phone?: string | undefined };
}): string {
  const selected = opts.values?.provider ?? opts.providers[0];
  const quantity = opts.values?.quantity ?? 1;
  const body = html`
  <div class="grid">
    <section class="card">
      <div class="product-art" aria-hidden="true">📓</div>
      <h1>${PRODUCT.name}</h1>
      <p class="muted">${PRODUCT.description}</p>
      <p class="price">${formatMoney(PRODUCT.price)}</p>
    </section>
    <section class="card">
      <form method="post" action="/checkout" class="stack">
        <h2>Checkout</h2>
        ${notice(opts.error, "bad")}
        <div>
          <label for="quantity">Quantity</label>
          <select id="quantity" name="quantity">
            ${[1, 2, 3, 4, 5].map(
              (n) =>
                html`<option value="${n}"${n === quantity ? html` selected` : ""}>${n} · ${formatMoney({
                  value: PRODUCT.price.value * n,
                  currency: PRODUCT.price.currency,
                })}</option>`,
            )}
          </select>
        </div>
        <div>
          <label for="phone">Phone</label>
          <input id="phone" name="phone" type="tel" autocomplete="tel" value="${opts.values?.phone ?? "+201001234567"}" required>
        </div>
        <fieldset>
          <legend>Pay with</legend>
          <div class="options">
            ${opts.providers.map(
              (p) => html`<label class="option">
                <input type="radio" name="provider" value="${p}"${p === selected ? html` checked` : ""}>
                <div><strong>${PROVIDER_INFO[p].label}</strong><span>${PROVIDER_INFO[p].detail}</span></div>
              </label>`,
            )}
          </div>
        </fieldset>
        <button class="block" type="submit">Continue to payment</button>
        <p class="muted small">You will be sent to the provider's page, or get a Fawry code to pay in cash.</p>
      </form>
    </section>
  </div>`;
  return page("Shop", body, { demo: opts.demo, nav: "shop" });
}

export function order(opts: {
  demo: boolean;
  order: Order;
  notice?: string | undefined;
  error?: string | undefined;
}): string {
  const o = opts.order;
  const pending = isPending(o.status);
  const refundable = o.status === "succeeded" || o.status === "partially_refunded";
  const body = html`
  <div class="stack" style="max-width: 560px">
    <div>
      <p class="muted small"><a href="/orders">← Orders</a></p>
      <h1>${headline(o.status)}</h1>
      <p class="muted">${PRODUCT.name} × ${o.quantity}</p>
    </div>
    ${notice(opts.notice, "ok")}
    ${notice(opts.error, "bad")}
    ${
      o.referenceCode && pending
        ? html`<section class="card stack">
        <h2>Pay at any Fawry outlet or in the Fawry app</h2>
        <div class="code">${o.referenceCode}</div>
        <p class="muted small">Give this code and ${formatMoney(o.amount)}${o.expiresAt ? html` before ${new Date(o.expiresAt).toLocaleString("en-GB")}` : ""}. This page updates when Fawry confirms.</p>
        ${
          opts.demo
            ? html`<form method="post" action="/demo/fawry/${o.reference}"><button class="secondary" type="submit">Demo: simulate paying at an outlet</button></form>`
            : ""
        }
      </section>`
        : ""
    }
    <section class="card stack">
      <dl>
        <dt>Status</dt><dd>${badge(o.status)}</dd>
        <dt>Amount</dt><dd>${formatMoney(o.amount)}</dd>
        ${o.refunded.value > 0 ? html`<dt>Refunded</dt><dd>${formatMoney(o.refunded)}</dd>` : ""}
        <dt>Provider</dt><dd>${PROVIDER_INFO[o.provider].label}</dd>
        <dt>Reference</dt><dd><code>${o.reference}</code></dd>
      </dl>
      ${pending ? html`<p class="muted small">Status changes only when a verified webhook arrives. This page refreshes itself.</p>` : ""}
      <div class="actions">
        <form method="post" action="/orders/${o.reference}/reconcile"><button class="secondary" type="submit">Check status with ${PROVIDER_INFO[o.provider].label}</button></form>
        ${refundable ? html`<form method="post" action="/orders/${o.reference}/refund"><button class="secondary" type="submit">Refund</button></form>` : ""}
      </div>
    </section>
  </div>`;
  return page(o.reference, body, { demo: opts.demo, refreshSeconds: pending ? 3 : undefined });
}

export function orders(opts: { demo: boolean; orders: Order[] }): string {
  const rows = opts.orders.map(
    (o) => html`<tr>
      <td><a href="/orders/${o.reference}">${o.reference}</a></td>
      <td>${PROVIDER_INFO[o.provider].label}</td>
      <td>${formatMoney(o.amount)}</td>
      <td>${badge(o.status)}</td>
      <td class="muted">${new Date(o.createdAt).toLocaleTimeString("en-GB")}</td>
    </tr>`,
  );
  const body = html`
  <h1>Orders</h1>
  <p class="muted">Kept in memory for this demo. Status comes from verified webhooks, never from redirects.</p>
  <section class="card" style="padding: 0; margin-top: 24px">
    ${
      rows.length
        ? html`<div class="table-wrap"><table>
          <thead><tr><th>Reference</th><th>Provider</th><th>Amount</th><th>Status</th><th>Created</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`
        : html`<div class="empty muted">No orders yet. <a href="/">Buy something</a>.</div>`
    }
  </section>`;
  return page("Orders", body, {
    demo: opts.demo,
    nav: "orders",
    refreshSeconds: opts.orders.some((o) => isPending(o.status)) ? 3 : undefined,
  });
}

/** Stands in for the provider's hosted payment page in demo mode. */
export function fakeCheckout(opts: { order: Order }): string {
  const o = opts.order;
  const body = html`
  <div class="card fake-checkout stack">
    <div class="provider-tag">${PROVIDER_INFO[o.provider].label} · fake hosted checkout</div>
    <h1>${formatMoney(o.amount)}</h1>
    <p class="muted small">In a real integration this is ${PROVIDER_INFO[o.provider].label}'s page. Choose an outcome: the provider then sends a signed webhook to the shop, and you are redirected back.</p>
    <form method="post" action="/demo/pay/${o.reference}" class="stack">
      <button class="block" name="outcome" value="succeeded" type="submit">Approve payment</button>
      <button class="block secondary" name="outcome" value="failed" type="submit">Decline</button>
    </form>
  </div>`;
  return page("Pay", body, { demo: true });
}

export function notFound(demo: boolean): string {
  return page(
    "Not found",
    html`<div class="card empty"><h1>Order not found</h1><p class="muted"><a href="/orders">Back to orders</a></p></div>`,
    { demo },
  );
}
