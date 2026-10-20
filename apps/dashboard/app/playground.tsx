"use client";

import { useState } from "react";

interface Result {
  input?: unknown | undefined;
  checkout?: {
    kind: string;
    redirectUrl?: string | undefined;
    referenceCode?: string | undefined;
    expiresAt?: string | undefined;
    raw?: unknown | undefined;
  };
  normalized?: unknown | undefined;
  http?: unknown[] | undefined;
  error?: { code?: string; message: string } | undefined;
  demo?: boolean | undefined;
  demoWebhook?: { rawBody: string; headers: Record<string, string> } | undefined;
}

export function Playground({ providers }: { providers: { id: string; methods: string[] }[] }) {
  const [provider, setProvider] = useState(providers[0]?.id ?? "");
  const [method, setMethod] = useState("");
  const [amount, setAmount] = useState("250.00");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const methods = providers.find((p) => p.id === provider)?.methods ?? [];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, amount, method: method || undefined }),
      });
      const data = (await res.json()) as Result;
      setResult(data);
      if (data.demo && data.demoWebhook) {
        await fetch(`/webhooks/${provider}`, {
          method: "POST",
          headers: data.demoWebhook.headers,
          body: data.demoWebhook.rawBody,
        });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form className="card inline" onSubmit={submit}>
        <label>
          Provider
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              setMethod("");
            }}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          Method
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="">provider default</option>
            {methods.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          Amount (EGP)
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create checkout"}
        </button>
      </form>

      {result && (
        <>
          <div className="card">
            {result.error ? (
              <p className="bad">
                {result.error.code ?? "ERROR"}: {result.error.message}
              </p>
            ) : result.checkout?.kind === "reference_code" ? (
              <p>
                Fawry reference code <b className="code">{result.checkout.referenceCode}</b>
                {result.checkout.expiresAt && (
                  <> · expires {new Date(result.checkout.expiresAt).toLocaleString()}</>
                )}
              </p>
            ) : (
              <p>
                Hosted page:{" "}
                <a href={result.checkout?.redirectUrl} target="_blank" rel="noreferrer">
                  open checkout ↗
                </a>{" "}
                <span className="muted">(webhooks will land in the inbox)</span>
              </p>
            )}
            {result.demo && (
              <p className="muted">Demo mode: a signed "succeeded" webhook was sent to the inbox.</p>
            )}
          </div>
          <div className="grid">
            <div className="card">
              <strong>Request (redacted)</strong>
              <pre>{JSON.stringify(result.http?.length ? result.http : result.input, null, 2)}</pre>
            </div>
            <div className="card">
              <strong>Raw response</strong>
              <pre>{JSON.stringify(result.checkout?.raw ?? result.error, null, 2)}</pre>
            </div>
            <div className="card">
              <strong>Normalized</strong>
              <pre>{JSON.stringify(result.normalized ?? null, null, 2)}</pre>
            </div>
          </div>
        </>
      )}
    </>
  );
}
