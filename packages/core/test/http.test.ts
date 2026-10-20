import { describe, expect, it, vi } from "vitest";
import { errorCodeForStatus, isSarrafError, SarrafError } from "../src/errors.js";
import { buildUrl, ensureOk, type FetchLike, HttpClient } from "../src/http.js";
import { silentLogger } from "../src/logger.js";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function client(fetchImpl: FetchLike, extra = {}) {
  return new HttpClient({ fetch: fetchImpl, logger: silentLogger, sleep: async () => {}, ...extra });
}

describe("HttpClient", () => {
  it("sends JSON and parses JSON", async () => {
    const f = vi.fn<FetchLike>(async () => json(200, { ok: 1 }));
    const res = await client(f).request({ method: "POST", url: "https://x.test/a", body: { a: 1 } });
    expect(res.data).toEqual({ ok: 1 });
    const [, init] = f.mock.calls[0]!;
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("returns text when the body is not JSON", async () => {
    const res = await client(async () => new Response("hello", { status: 200 })).request({
      method: "GET",
      url: "https://x.test",
    });
    expect(res.data).toBe("hello");
    const empty = await client(async () => new Response(null, { status: 204 })).request({
      method: "GET",
      url: "https://x.test",
    });
    expect(empty.data).toBeUndefined();
  });

  it("retries GET on 5xx and 429, honoring Retry-After", async () => {
    const sleep = vi.fn(async () => {});
    const f = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(json(503, {}))
      .mockResolvedValueOnce(json(429, {}, { "retry-after": "1" }))
      .mockResolvedValueOnce(json(200, { ok: true }));
    const res = await client(f, { sleep }).request({ method: "GET", url: "https://x.test" });
    expect(res.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenLastCalledWith(1000);
  });

  it("gives up after maxRetries", async () => {
    const f = vi.fn<FetchLike>(async () => json(500, {}));
    const res = await client(f, { maxRetries: 1 }).request({ method: "GET", url: "https://x.test" });
    expect(res.status).toBe(500);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("never retries money-moving calls", async () => {
    const f = vi.fn<FetchLike>(async () => json(503, {}));
    await client(f).request({ method: "POST", url: "https://x.test", moneyMoving: true, retryable: true });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("maps a money-moving timeout to TIMEOUT_UNKNOWN_OUTCOME", async () => {
    const f: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const err = await client(f)
      .request({ method: "POST", url: "https://x.test", moneyMoving: true, timeoutMs: 5, provider: "paymob" })
      .catch((e) => e);
    expect(isSarrafError(err, "TIMEOUT_UNKNOWN_OUTCOME")).toBe(true);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/Query the payment status/);
  });

  it("retries GET network errors then throws NETWORK_ERROR", async () => {
    const f = vi.fn<FetchLike>(async () => {
      throw new TypeError("fetch failed");
    });
    const err = await client(f)
      .request({ method: "GET", url: "https://x.test" })
      .catch((e) => e);
    expect(isSarrafError(err, "NETWORK_ERROR")).toBe(true);
    expect(err.retryable).toBe(true);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("emits redacted hook events", async () => {
    const events: unknown[] = [];
    const debug = vi.fn();
    const c = new HttpClient({
      fetch: async () => json(200, { token: "abc", email: "sara@example.com" }),
      hooks: { onRequest: (e) => events.push(e), onResponse: (e) => events.push(e) },
      logger: { ...silentLogger, debug },
      debug: true,
    });
    await c.request({
      method: "POST",
      url: "https://x.test/a?token=secret",
      headers: { Authorization: "Token sk_live" },
      body: { api_key: "k" },
    });
    const text = JSON.stringify(events);
    expect(text).not.toContain("sk_live");
    expect(text).not.toContain("secret");
    expect(text).not.toContain('"abc"');
    expect(text).not.toContain("sara@");
    expect(debug).toHaveBeenCalledTimes(2);
  });

  it("survives a throwing hook", async () => {
    const warn = vi.fn();
    const c = new HttpClient({
      fetch: async () => json(200, {}),
      hooks: {
        onRequest: () => {
          throw new Error("boom");
        },
      },
      logger: { ...silentLogger, warn },
    });
    await c.request({ method: "GET", url: "https://x.test" });
    expect(warn).toHaveBeenCalled();
  });

  it("requires a fetch implementation", () => {
    const original = globalThis.fetch;
    // @ts-expect-error simulate old runtime
    globalThis.fetch = undefined;
    try {
      expect(() => new HttpClient()).toThrow(/No fetch/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("helpers", () => {
  it("buildUrl skips undefined", () => {
    expect(buildUrl("https://x.test/a", { a: 1, b: undefined, c: "x y" })).toBe("https://x.test/a?a=1&c=x+y");
    expect(buildUrl("https://x.test/a")).toBe("https://x.test/a");
  });

  it("ensureOk throws mapped errors", () => {
    const ok = { status: 200, ok: true, headers: {}, data: {}, text: "" };
    expect(ensureOk(ok, "paymob", "x")).toBe(ok);
    const bad = { status: 401, ok: false, headers: {}, data: { detail: "bad key" }, text: "" };
    const err = ((): SarrafError | undefined => {
      try {
        ensureOk(bad, "paymob", "createIntention", (d) => (d as { detail: string }).detail);
      } catch (e) {
        return e as SarrafError;
      }
      return undefined;
    })();
    expect(err?.code).toBe("AUTHENTICATION_FAILED");
    expect(err?.message).toContain("bad key");
    expect(() => ensureOk({ ...bad, status: 400, data: "plain" }, "paymob", "x")).toThrow(/plain/);
  });

  it("errorCodeForStatus", () => {
    expect(errorCodeForStatus(403)).toBe("AUTHENTICATION_FAILED");
    expect(errorCodeForStatus(404)).toBe("NOT_FOUND");
    expect(errorCodeForStatus(409)).toBe("DUPLICATE_REFERENCE");
    expect(errorCodeForStatus(429)).toBe("RATE_LIMITED");
    expect(errorCodeForStatus(502)).toBe("PROVIDER_UNAVAILABLE");
    expect(errorCodeForStatus(422)).toBe("INVALID_REQUEST");
  });

  it("SarrafError serializes", () => {
    const e = new SarrafError("RATE_LIMITED", "slow down", { provider: "fawry", cause: new Error("x") });
    expect(e.retryable).toBe(true);
    expect(e.toJSON()).toMatchObject({ code: "RATE_LIMITED", provider: "fawry" });
    expect(isSarrafError(e)).toBe(true);
    expect(isSarrafError(new Error("x"))).toBe(false);
  });
});
