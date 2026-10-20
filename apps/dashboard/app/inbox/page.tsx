"use client";

import { useCallback, useEffect, useState } from "react";
import type { InboxEntry } from "../../lib/inbox";

export default function InboxPage() {
  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/inbox", { cache: "no-store" });
    if (res.ok) setEntries(await res.json());
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  async function replay(id: string) {
    setBusy(id);
    await fetch(`/api/inbox/${id}/replay`, { method: "POST" });
    await load();
    setBusy(null);
  }

  async function clear() {
    await fetch("/api/inbox", { method: "DELETE" });
    await load();
  }

  return (
    <>
      <h1>Webhook inbox</h1>
      <p className="lead">
        Point sandbox callbacks at <span className="code">{"<this dashboard>/webhooks/<provider>"}</span>.
        Every request is stored with its signature check, including the exact string that was hashed. Entries
        are deleted after 7 days.
      </p>
      <p>
        <button className="secondary" onClick={clear} type="button">
          Clear inbox
        </button>
      </p>
      {entries.length === 0 && (
        <div className="card muted">No webhooks yet. Create a checkout in the playground and pay it.</div>
      )}
      {entries.map((e) => (
        <details key={e.id} className="card entry">
          <summary>
            <span className={e.inspection.valid ? "ok" : "bad"}>
              {e.inspection.valid ? "✓ valid" : "✗ invalid"}
            </span>
            <span className="pill">{e.provider}</span>
            <span>
              {e.event
                ? `${e.event.type} · ${e.event.payment.reference}`
                : (e.inspection.reason ?? e.error ?? "")}
            </span>
            <span className="muted">{new Date(e.receivedAt).toLocaleString()}</span>
            {e.replays > 0 && <span className="muted">replayed ×{e.replays}</span>}
          </summary>
          <p>
            <button type="button" onClick={() => replay(e.id)} disabled={busy === e.id}>
              {busy === e.id ? "Replaying…" : "Replay verification"}
            </button>
          </p>
          <div className="grid">
            <div>
              <strong>Signature</strong>
              <pre>
                {JSON.stringify(
                  {
                    algorithm: e.inspection.algorithm,
                    signedString: e.inspection.signedString,
                    expected: e.inspection.expected,
                    received: e.inspection.received,
                    reason: e.inspection.reason,
                  },
                  null,
                  2,
                )}
              </pre>
            </div>
            <div>
              <strong>Raw payload</strong>
              <pre>{prettify(e.rawBody)}</pre>
              <strong>Query</strong>
              <pre>{JSON.stringify(e.query, null, 2)}</pre>
            </div>
            <div>
              <strong>Normalized event</strong>
              <pre>
                {JSON.stringify(e.event ? { ...e.event, raw: undefined } : (e.error ?? null), null, 2)}
              </pre>
            </div>
          </div>
        </details>
      ))}
    </>
  );
}

function prettify(raw: string) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
