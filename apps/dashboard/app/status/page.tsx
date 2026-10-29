import type { StatusMappingRow } from "@sarrafjs/core";
import { FAWRY_STATUS_TABLE } from "@sarrafjs/fawry";
import { KASHIER_STATUS_TABLE } from "@sarrafjs/kashier";
import { PAYMOB_STATUS_TABLE } from "@sarrafjs/paymob";

const TABLES: [string, StatusMappingRow[]][] = [
  ["Paymob", PAYMOB_STATUS_TABLE],
  ["Kashier", KASHIER_STATUS_TABLE],
  ["Fawry", FAWRY_STATUS_TABLE],
];

export default function StatusPage() {
  return (
    <>
      <h1>Status explorer</h1>
      <p className="lead">
        How each provider's payment states map to Sarraf statuses. "To verify" rows still need a recorded
        sandbox fixture.
      </p>
      {TABLES.map(([name, rows]) => (
        <section key={name} className="card">
          <h2 style={{ fontSize: 17, margin: "0 0 8px" }}>{name}</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Provider state</th>
                  <th>Sarraf status</th>
                  <th>Note</th>
                  <th>Verified</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.provider}>
                    <td className="code">{r.provider}</td>
                    <td>
                      <span className="pill">{r.status}</span>
                    </td>
                    <td className="muted">{r.note ?? ""}</td>
                    <td className={r.verified ? "ok" : "muted"}>{r.verified ? "✓" : "to verify"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  );
}
