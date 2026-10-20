import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sarraf, silentLogger } from "@sarraf/core";
import { paymobTransaction, signPaymobCallback } from "@sarraf/paymob/testing";
import { describe, expect, it } from "vitest";
import { Inbox, RETENTION_MS } from "../lib/inbox";
import { RateLimiter, clientKey } from "../lib/rate-limit";
import { assertNoLiveKeys, buildProviders } from "../lib/sarraf";
import { captureWebhook, replayWebhook } from "../lib/webhooks";

const tmpInbox = (now?: () => number) =>
  new Inbox(join(mkdtempSync(join(tmpdir(), "sarraf-")), "inbox.json"), now);

describe("sandbox safety", () => {
  it("refuses live keys and production environments", () => {
    expect(() => assertNoLiveKeys({ PAYMOB_SECRET_KEY: "sk_live_abc" })).toThrow(/LIVE key/);
    expect(() => assertNoLiveKeys({ KASHIER_MODE: "live" })).toThrow(/sandbox/);
    expect(() => assertNoLiveKeys({ FAWRY_ENVIRONMENT: "production" })).toThrow(/sandbox/);
    expect(() => assertNoLiveKeys({ PAYMOB_SECRET_KEY: "sk_test_abc", OTHER: "live_x" })).not.toThrow();
  });

  it("falls back to demo providers without credentials", () => {
    const { providers, demo } = buildProviders({});
    expect(demo).toBe(true);
    expect(Object.keys(providers)).toEqual(["paymob", "kashier", "fawry"]);
  });

  it("builds real adapters from sandbox env", () => {
    const { providers, demo } = buildProviders({
      PAYMOB_SECRET_KEY: "sk_test_a",
      PAYMOB_PUBLIC_KEY: "pk_test_a",
      PAYMOB_HMAC_SECRET: "h",
      PAYMOB_CARD_INTEGRATION_ID: "1",
      PAYMOB_WALLET_INTEGRATION_ID: "2",
      KASHIER_MERCHANT_ID: "MID-1",
      KASHIER_API_KEY: "k",
      FAWRY_MERCHANT_CODE: "M",
      FAWRY_SECURE_KEY: "s",
    });
    expect(demo).toBe(false);
    expect(providers.paymob?.capabilities.methods).toEqual({ card: "supported", wallet: "supported" });
    expect(providers.kashier?.id).toBe("kashier");
    expect(providers.fawry?.id).toBe("fawry");
  });
});

describe("Inbox", () => {
  it("adds, updates, prunes after 7 days and clears", () => {
    let now = Date.parse("2026-10-20T00:00:00Z");
    const box = tmpInbox(() => now);
    expect(box.list()).toEqual([]);
    const e = box.add({
      provider: "paymob",
      headers: {},
      query: {},
      rawBody: "{}",
      inspection: { valid: false, algorithm: "x" },
    });
    expect(box.get(e.id)?.replays).toBe(0);
    expect(box.update(e.id, { replays: 1 })?.replays).toBe(1);
    expect(box.update("nope", { replays: 1 })).toBeUndefined();
    now += RETENTION_MS + 1;
    expect(box.list()).toEqual([]);
    box.add({
      provider: "fawry",
      headers: {},
      query: {},
      rawBody: "{}",
      inspection: { valid: true, algorithm: "x" },
    });
    box.clear();
    expect(box.list()).toEqual([]);
  });
});

describe("RateLimiter", () => {
  it("limits per key per window", () => {
    let now = 0;
    const rl = new RateLimiter(2, 1000, () => now);
    expect([rl.take("a"), rl.take("a"), rl.take("a"), rl.take("b")]).toEqual([true, true, false, true]);
    now = 1001;
    expect(rl.take("a")).toBe(true);
  });

  it("derives the client key", () => {
    expect(clientKey(new Request("http://x", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } }))).toBe(
      "1.2.3.4",
    );
    expect(clientKey(new Request("http://x", { headers: { "x-real-ip": "9.9.9.9" } }))).toBe("9.9.9.9");
    expect(clientKey(new Request("http://x"))).toBe("local");
  });
});

describe("capture and replay", () => {
  it("stores valid and invalid webhooks with the hashed string, and replays them", async () => {
    const { providers } = buildProviders({
      PAYMOB_SECRET_KEY: "sk_test_a",
      PAYMOB_PUBLIC_KEY: "pk_test_a",
      PAYMOB_HMAC_SECRET: "secret",
      PAYMOB_CARD_INTEGRATION_ID: "1",
    });
    const pay = new Sarraf({ providers, logger: silentLogger });
    const box = tmpInbox();
    const signed = signPaymobCallback(paymobTransaction(), "secret");
    const ok = await captureWebhook(pay, box, "paymob", {
      headers: {},
      query: signed.query as Record<string, string>,
      rawBody: signed.rawBody as string,
    });
    expect(ok.inspection.valid).toBe(true);
    expect(ok.inspection.signedString).toContain("25000");
    expect(ok.event?.type).toBe("payment.succeeded");

    const bad = await captureWebhook(pay, box, "paymob", {
      headers: {},
      query: { hmac: "00" },
      rawBody: signed.rawBody as string,
    });
    expect(bad.inspection.valid).toBe(false);
    expect(bad.event).toBeUndefined();

    const replayed = await replayWebhook(pay, box, ok.id);
    expect(replayed?.replays).toBe(1);
    expect(await replayWebhook(pay, box, "missing")).toBeUndefined();
    expect(box.list()).toHaveLength(2);
  });
});
