import { isSarrafError } from "@sarrafjs/core";
/**
 * Contract tests against the real provider sandboxes. Run locally with `pnpm test:sandbox`
 * (reads .env.sandbox) and nightly in CI with repository secrets. Each provider is skipped
 * when its credentials are missing.
 */
import { describe, expect, it } from "vitest";
import { env, hasFawry, hasKashier, hasPaymob, loadSandboxEnv } from "../../scripts/env.js";
import { sandboxSarraf } from "../../scripts/providers.js";

loadSandboxEnv();

const customer = { name: "Sandbox Tester", email: "tester@example.com", phone: "+201000000000" };
const amount = { value: 1000, currency: "EGP" as const };
const ref = (p: string) => `sarraf_ct_${p}_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;

describe.skipIf(!hasPaymob())("@sandbox paymob", () => {
  it("creates an intention and a unified checkout URL", async () => {
    const pay = sandboxSarraf();
    const checkout = await pay.checkout.create({
      provider: "paymob",
      amount,
      reference: ref("pm"),
      customer,
      returnUrl: "https://example.com/return",
    });
    expect(checkout.redirectUrl).toMatch(/\/unifiedcheckout\/\?publicKey=.+&clientSecret=.+/);
    expect(checkout.payment.providerPaymentId).toBe("");
    const page = await fetch(checkout.redirectUrl!, { redirect: "manual" });
    expect(page.status).toBeLessThan(500);
  });

  it("reads a known transaction", {
    skip: !env("PAYMOB_API_KEY") || !env("PAYMOB_SANDBOX_TRANSACTION_ID"),
  }, async () => {
    const pay = sandboxSarraf();
    const p = await pay.payments.get({
      provider: "paymob",
      providerPaymentId: env("PAYMOB_SANDBOX_TRANSACTION_ID")!,
    });
    expect(p.providerPaymentId).toBe(env("PAYMOB_SANDBOX_TRANSACTION_ID"));
    expect(p.amount.value).toBeGreaterThan(0);
  });

  it("updates and retrieves an unpaid intention", async () => {
    const pay = sandboxSarraf();
    const checkout = await pay.checkout.create({
      provider: "paymob",
      amount,
      reference: ref("pm"),
      customer,
    });
    const { extras } = pay.provider("paymob");
    const updated = await extras.intentions.update(checkout, {
      amount: 1500,
      items: [{ name: "Updated", amount: 1500, quantity: 1 }],
    });
    expect(updated.client_secret).toBeTruthy();
    const read = await extras.intentions.retrieve(checkout);
    expect(read).toBeTruthy();
  });

  it("issues a kiosk bill reference", { skip: !env("PAYMOB_KIOSK_INTEGRATION_ID") }, async () => {
    const pay = sandboxSarraf();
    const checkout = await pay.checkout.create({
      provider: "paymob",
      amount,
      reference: ref("pm"),
      customer,
      methods: ["cash_outlet"],
    });
    expect(checkout.kind).toBe("reference_code");
    expect(checkout.referenceCode).toMatch(/^\d+$/);
    expect(checkout.payment.status).toBe("awaiting_payment");
  });

  it("creates and cancels a payment link", { skip: !env("PAYMOB_API_KEY") }, async () => {
    const { extras } = sandboxSarraf().provider("paymob");
    const link = await extras.links.create({
      amount,
      reference: ref("pm"),
      expiresAt: new Date(Date.now() + 3600 * 1000),
    });
    expect(link.url).toMatch(/^https:\/\//);
    await extras.links.cancel(link.id);
  });

  it("captures an authorization", {
    skip: !env("PAYMOB_API_KEY") || !env("PAYMOB_SANDBOX_AUTH_TRANSACTION_ID"),
  }, async () => {
    const pay = sandboxSarraf();
    const p = await pay.payments.capture({
      provider: "paymob",
      providerPaymentId: env("PAYMOB_SANDBOX_AUTH_TRANSACTION_ID")!,
      amount: { value: 100, currency: "EGP" },
    });
    expect(p.status).toBe("succeeded");
  });

  it("rejects a bad secret key with AUTHENTICATION_FAILED", async () => {
    const { paymob } = await import("@sarrafjs/paymob");
    const { Sarraf } = await import("@sarrafjs/core");
    const pay = new Sarraf({
      providers: {
        paymob: paymob({
          secretKey: "sk_test_invalid",
          publicKey: env("PAYMOB_PUBLIC_KEY")!,
          hmacSecret: "x",
          integrationIds: { card: Number(env("PAYMOB_CARD_INTEGRATION_ID") ?? 1) },
        }),
      },
    });
    const err = await pay.checkout
      .create({ provider: "paymob", amount, reference: ref("pm"), customer })
      .catch((e) => e);
    expect(isSarrafError(err)).toBe(true);
    expect(["AUTHENTICATION_FAILED", "INVALID_REQUEST"]).toContain(err.code);
  });
});

describe.skipIf(!hasKashier())("@sandbox kashier", () => {
  // The hosted page only checks the hash when the customer pays, so this proves the merchant id and
  // mode are accepted, not the hash. The hash, redirect and webhook recipes are locked in by the
  // recorded fixtures (fixtures/kashier/sandbox-*.json): record new ones with `pnpm record-fixtures`.
  it("builds a hosted payment page for this merchant", async () => {
    const pay = sandboxSarraf();
    const checkout = await pay.checkout.create({
      provider: "kashier",
      amount,
      reference: ref("ks"),
      customer,
      returnUrl: "https://example.com/return",
    });
    const res = await fetch(checkout.redirectUrl!);
    expect(res.status).toBeLessThan(500);
    const html = await res.text();
    expect(html.toLowerCase()).not.toContain("invalid hash");
  });

  it("looks up a known paid order by reference", {
    skip: !env("KASHIER_SECRET_KEY") || !env("KASHIER_SANDBOX_REFERENCE"),
  }, async () => {
    const pay = sandboxSarraf();
    const reference = env("KASHIER_SANDBOX_REFERENCE")!;
    const p = await pay.payments.get({ provider: "kashier", reference });
    expect(p.reference).toBe(reference);
    expect(["succeeded", "partially_refunded", "refunded"]).toContain(p.status);
    expect(p.amount.value).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasFawry())("@sandbox fawry", () => {
  it("creates a PayAtFawry reference code and reads it back as awaiting payment", async () => {
    const pay = sandboxSarraf();
    const reference = ref("fw");
    const checkout = await pay.checkout.create({
      provider: "fawry",
      amount,
      reference,
      customer,
      expiresInSeconds: 3600,
    });
    expect(checkout.kind).toBe("reference_code");
    expect(checkout.referenceCode).toMatch(/^\d+$/);
    const status = await pay.payments.get({ provider: "fawry", reference });
    expect(["awaiting_payment", "pending"]).toContain(status.status);
    expect(status.amount).toEqual(amount);
  });
});
