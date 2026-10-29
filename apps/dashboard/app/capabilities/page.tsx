import type { Capabilities, CapabilityLevel } from "@sarrafjs/core";
import { getSarraf } from "../../lib/sarraf";

export const dynamic = "force-dynamic";

const ROWS: [string, (c: Capabilities) => CapabilityLevel | string][] = [
  ["Checkout", (c) => c.checkout],
  ["Checkout kinds", (c) => c.checkoutKinds.join(", ")],
  ["Get payment / reconcile", (c) => c.getPayment],
  ["Refund", (c) => c.refund],
  ["Partial refund", (c) => c.partialRefund],
  ["Void / cancel", (c) => c.cancel],
  ["Webhook verification", (c) => c.webhooks],
  ["Redirect verification", (c) => c.redirectVerification],
  ["Card", (c) => c.methods.card ?? "unsupported"],
  ["Wallet", (c) => c.methods.wallet ?? "unsupported"],
  ["Cash at outlet", (c) => c.methods.cash_outlet ?? "unsupported"],
  ["Installments", (c) => c.methods.installments ?? "unsupported"],
  ["BNPL", (c) => c.methods.bnpl ?? "unsupported"],
  ["Currencies", (c) => c.currencies.join(", ")],
];

const mark = (v: string) =>
  v === "supported" ? (
    <span className="ok">✓ supported</span>
  ) : v === "beta" ? (
    <span className="pill">beta</span>
  ) : v === "unsupported" ? (
    <span className="muted">—</span>
  ) : (
    v
  );

export default function CapabilitiesPage() {
  const { pay } = getSarraf();
  const ids = pay.providerIds;
  return (
    <>
      <h1>Capabilities</h1>
      <p className="lead">Live output of pay.capabilities(provider) for the configured adapters.</p>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Feature</th>
              {ids.map((id) => (
                <th key={id}>{id}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map(([label, get]) => (
              <tr key={label}>
                <td>{label}</td>
                {ids.map((id) => (
                  <td key={id}>{mark(String(get(pay.capabilities(id))))}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
