import { describe, expect, it } from "vitest";
import { safeEqualHex, sha256Hex } from "../src/crypto.js";
import { buildEvent, eventTypeForStatus, refundedStatus, sarrafId } from "../src/helpers.js";
import { MemoryStore } from "../src/idempotency/memory.js";
import { RedisStore } from "../src/idempotency/redis.js";
import { consoleLogger, defaultLogger, silentLogger } from "../src/logger.js";
import { REDACTED, maskEmail, maskPhone, redact, redactUrl } from "../src/redact.js";
import { assertServerRuntime } from "../src/runtime.js";
import {
  asRecord,
  getPath,
  normalizeHeaders,
  normalizeQuery,
  parseJsonBody,
  rawBodyToString,
  str,
} from "../src/webhook-utils.js";

describe("redact", () => {
  it("removes secrets and masks PII deeply", () => {
    const out = redact({
      secretKey: "sk",
      nested: { hmac: "h", phone_number: "+201001234567", email: "sara@example.com" },
      list: [{ token: "t" }, "contact sara@example.com"],
      signatureKeys: ["amount"],
      amount: 100,
      when: new Date(0),
      empty: "",
    });
    expect(out.secretKey).toBe(REDACTED);
    expect(out.nested.hmac).toBe(REDACTED);
    expect(out.nested.phone_number).toBe("***67");
    expect(out.nested.email).toBe("s***@example.com");
    expect(out.list[0]).toEqual({ token: REDACTED });
    expect(out.list[1]).toBe("contact s***@example.com");
    expect(out.signatureKeys).toEqual(["amount"]);
    expect(out.amount).toBe(100);
    expect(out.when).toBeInstanceOf(Date);
  });

  it("masks short values and URLs", () => {
    expect(maskEmail("nope")).toBe(REDACTED);
    expect(maskPhone("12")).toBe(REDACTED);
    expect(redactUrl("https://x.test/?publicKey=pk&clientSecret=cs&a=1&email=a@b.co&mobile=0100123")).toBe(
      "https://x.test/?publicKey=%5BREDACTED%5D&clientSecret=%5BREDACTED%5D&a=1&email=a***%40b.co&mobile=***23",
    );
    expect(redactUrl("not a url")).toBe("not a url");
    expect(redact("https://x.test/?token=abc")).toContain("REDACTED");
  });

  it("stops at deep nesting", () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 30; i++) {
      deep.child = {};
      deep = deep.child as Record<string, unknown>;
    }
    expect(JSON.stringify(redact(root))).toContain(REDACTED);
  });
});

describe("crypto", () => {
  it("compares hex safely", () => {
    const h = sha256Hex("x");
    expect(safeEqualHex(h, h.toUpperCase())).toBe(true);
    expect(safeEqualHex(h, `${h.slice(0, -1)}0`)).toBe(h.endsWith("0"));
    expect(safeEqualHex(h, h.slice(2))).toBe(false);
    expect(safeEqualHex(undefined, h)).toBe(false);
    expect(safeEqualHex("zz", "zz")).toBe(false);
    expect(safeEqualHex("", "")).toBe(false);
  });
});

describe("idempotency stores", () => {
  it("MemoryStore expires and locks", async () => {
    let now = 0;
    const s = new MemoryStore(() => now);
    expect(await s.setIfAbsent("k", { a: 1 }, 10)).toBe(true);
    expect(await s.setIfAbsent("k", { a: 2 }, 10)).toBe(false);
    expect(await s.get("k")).toEqual({ a: 1 });
    now = 11_000;
    expect(await s.get("k")).toBeUndefined();
    await s.set("k", 1, 10);
    await s.delete("k");
    expect(await s.get("k")).toBeUndefined();
  });

  it("RedisStore uses SET EX NX", async () => {
    const data = new Map<string, string>();
    const calls: unknown[][] = [];
    const redis = {
      get: async (k: string) => data.get(k) ?? null,
      set: async (k: string, v: string, ...args: (string | number)[]) => {
        calls.push(args);
        if (args.includes("NX") && data.has(k)) return null;
        data.set(k, v);
        return "OK";
      },
      del: async (k: string) => data.delete(k),
    };
    const s = new RedisStore(redis);
    expect(await s.setIfAbsent("a", { x: 1 }, 1.2)).toBe(true);
    expect(await s.setIfAbsent("a", { x: 2 }, 1)).toBe(false);
    expect(await s.get("a")).toEqual({ x: 1 });
    expect(calls[0]).toEqual(["EX", 2, "NX"]);
    await s.set("b", 2, 5);
    await s.delete("a");
    expect(await s.get("a")).toBeUndefined();
    expect([...data.keys()]).toEqual(["sarraf:idem:b"]);
  });
});

describe("webhook utils", () => {
  it("normalizes headers from objects and Headers", () => {
    expect(normalizeHeaders({ "X-A": "1", "X-B": ["2", "3"], "X-C": undefined })).toEqual({
      "x-a": "1",
      "x-b": "2",
    });
    expect(normalizeHeaders(new Headers({ "X-A": "1" }))).toEqual({ "x-a": "1" });
    expect(normalizeHeaders(undefined)).toEqual({});
    expect(normalizeQuery({ a: ["1", "2"], b: undefined })).toEqual({ a: "1" });
    expect(normalizeQuery(undefined)).toEqual({});
  });

  it("reads bodies", () => {
    expect(rawBodyToString(new TextEncoder().encode("مرحبا"))).toBe("مرحبا");
    expect(() => rawBodyToString({} as never)).toThrow(/rawBody/);
    expect(parseJsonBody("paymob", '{"a":1}')).toEqual({ a: 1 });
    expect(() => parseJsonBody("paymob", "{")).toThrow(/WEBHOOK_SIGNATURE_INVALID/);
  });

  it("reads paths", () => {
    expect(getPath({ order: { id: 5 } }, "order.id")).toBe(5);
    expect(getPath({ order: null }, "order.id")).toBeUndefined();
    expect(asRecord([1])).toEqual({});
    expect(str(null)).toBeUndefined();
    expect(str(5)).toBe("5");
  });
});

describe("helpers", () => {
  it("maps statuses to event types", () => {
    expect(eventTypeForStatus("succeeded")).toBe("payment.succeeded");
    expect(eventTypeForStatus("failed")).toBe("payment.failed");
    expect(eventTypeForStatus("expired")).toBe("payment.expired");
    expect(eventTypeForStatus("canceled")).toBe("payment.canceled");
    expect(eventTypeForStatus("refunded")).toBe("refund.succeeded");
    expect(eventTypeForStatus("partially_refunded")).toBe("refund.succeeded");
    expect(eventTypeForStatus("awaiting_payment")).toBe("payment.pending");
    expect(refundedStatus({ value: 10, currency: "EGP" }, { value: 5, currency: "EGP" })).toBe(
      "partially_refunded",
    );
    expect(refundedStatus({ value: 10, currency: "EGP" }, { value: 10, currency: "EGP" })).toBe("refunded");
    expect(sarrafId("paymob", 12)).toBe("paymob_12");
  });

  it("builds events with stable ids", () => {
    const payment = {
      id: "paymob_1",
      provider: "paymob" as const,
      providerPaymentId: "1",
      reference: "r",
      status: "succeeded" as const,
      amount: { value: 1, currency: "EGP" as const },
      amountRefunded: { value: 0, currency: "EGP" as const },
      raw: {},
    };
    const e = buildEvent({
      provider: "paymob",
      providerEventId: 1,
      payment,
      receivedAt: new Date(0),
      raw: {},
    });
    expect(e.id).toBe("paymob:1:succeeded");
    expect(e.receivedAt).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("runtime guard and loggers", () => {
  it("throws in a browser-like global", () => {
    expect(() => assertServerRuntime({ window: {}, document: {} })).toThrow(/server-side only/);
    expect(() =>
      assertServerRuntime({ window: {}, document: {}, process: { versions: { node: "20" } } }),
    ).not.toThrow();
    expect(() => assertServerRuntime({})).not.toThrow();
  });

  it("loggers are callable", () => {
    for (const l of [silentLogger, defaultLogger, consoleLogger]) {
      expect(typeof l.debug).toBe("function");
    }
  });
});
