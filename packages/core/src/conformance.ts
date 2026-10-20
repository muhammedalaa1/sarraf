import { describe, expect, it } from "vitest";
import { isSarrafError } from "./errors.js";
import type { Sarraf } from "./sarraf.js";
import type {
  CheckoutKind,
  CreateCheckoutInput,
  PaymentLookup,
  ProviderId,
  RawWebhookRequest,
  RefundInput,
} from "./types.js";

export interface ConformanceHarness {
  /** A Sarraf instance with this provider configured against a mocked fetch. */
  sarraf: Sarraf;
  provider: ProviderId;
  checkoutInput: CreateCheckoutInput;
  expectedCheckoutKind: CheckoutKind;
  webhooks: {
    /** A correctly signed "payment succeeded" notification. */
    succeeded: RawWebhookRequest;
    /** The same notification with a modified amount or status and the original signature. */
    tampered: RawWebhookRequest;
    /** A correctly signed refund notification, when the provider sends one. */
    refunded?: RawWebhookRequest | undefined;
    /** Merchant reference carried by the webhooks. Defaults to `checkoutInput.reference`. */
    reference?: string | undefined;
  };
  /** Lookup for getPayment; the mock must answer with a paid payment. */
  lookup: PaymentLookup;
  /** Omit when the adapter does not support refunds. */
  refund?: Omit<RefundInput, "idempotencyKey"> | undefined;
  /** Number of fetch calls made so far. */
  fetchCalls(): number;
}

/**
 * Shared behaviour every adapter must pass:
 * create → webhook succeeded → get → refund → webhook refunded, plus tamper and idempotency checks.
 */
export function runConformanceTests(
  name: string,
  setup: () => ConformanceHarness | Promise<ConformanceHarness>,
): void {
  describe(`${name} conformance`, () => {
    it("declares a complete capability set", async () => {
      const h = await setup();
      const caps = h.sarraf.capabilities(h.provider);
      expect(caps.checkout).not.toBe("unsupported");
      expect(caps.webhooks).toBe("supported");
      expect(caps.currencies.length).toBeGreaterThan(0);
      expect(caps.checkoutKinds).toContain(h.expectedCheckoutKind);
      expect(caps.docsUrl).toMatch(/^https?:\/\//);
    });

    it("creates a checkout with a normalized shape", async () => {
      const h = await setup();
      const checkout = await h.sarraf.checkout.create(h.checkoutInput);
      expect(checkout.provider).toBe(h.provider);
      expect(checkout.id.startsWith(`${h.provider}_`)).toBe(true);
      expect(checkout.kind).toBe(h.expectedCheckoutKind);
      if (checkout.kind === "redirect") expect(checkout.redirectUrl).toMatch(/^https:\/\//);
      else expect(checkout.referenceCode).toBeTruthy();
      expect(["pending", "awaiting_payment", "requires_action"]).toContain(checkout.payment.status);
      expect(checkout.payment.amount).toEqual(h.checkoutInput.amount);
      expect(checkout.payment.reference).toBe(h.checkoutInput.reference);
    });

    it("does not call the provider twice for the same idempotency key", async () => {
      const h = await setup();
      const input = { ...h.checkoutInput, idempotencyKey: `conf-${h.provider}` };
      const a = await h.sarraf.checkout.create(input);
      const calls = h.fetchCalls();
      const b = await h.sarraf.checkout.create(input);
      expect(h.fetchCalls()).toBe(calls);
      expect(b).toEqual(a);
    });

    it("verifies and normalizes a succeeded webhook", async () => {
      const h = await setup();
      const event = await h.sarraf.webhooks.verifyAndParse(h.provider, h.webhooks.succeeded);
      expect(event.type).toBe("payment.succeeded");
      expect(event.provider).toBe(h.provider);
      expect(event.payment.status).toBe("succeeded");
      expect(event.payment.amount).toEqual(h.checkoutInput.amount);
      expect(event.payment.reference).toBe(h.webhooks.reference ?? h.checkoutInput.reference);
      expect(event.id.startsWith(`${h.provider}:`)).toBe(true);
      expect(event.id.endsWith(":succeeded")).toBe(true);
      const again = await h.sarraf.webhooks.verifyAndParse(h.provider, h.webhooks.succeeded);
      expect(h.sarraf.webhooks.dedupeKey(again)).toBe(h.sarraf.webhooks.dedupeKey(event));
    });

    it("rejects a tampered webhook", async () => {
      const h = await setup();
      const err = await h.sarraf.webhooks
        .verifyAndParse(h.provider, h.webhooks.tampered)
        .catch((e: unknown) => e);
      expect(isSarrafError(err, "WEBHOOK_SIGNATURE_INVALID")).toBe(true);
      const inspection = await h.sarraf.webhooks.inspect(h.provider, h.webhooks.tampered);
      expect(inspection.valid).toBe(false);
    });

    it("explains a valid signature", async () => {
      const h = await setup();
      const inspection = await h.sarraf.webhooks.inspect(h.provider, h.webhooks.succeeded);
      expect(inspection.valid).toBe(true);
      expect(inspection.signedString).toBeTruthy();
    });

    it("gets a payment with a known status", async () => {
      const h = await setup();
      const payment = await h.sarraf.payments.get({ provider: h.provider, ...h.lookup });
      expect(payment.status).toBe("succeeded");
      expect(payment.provider).toBe(h.provider);
      expect(payment.id.startsWith(`${h.provider}_`)).toBe(true);
    });

    it("refunds and reports the refund", async () => {
      const h = await setup();
      if (!h.refund) return;
      const refund = await h.sarraf.refunds.create({ provider: h.provider, ...h.refund });
      expect(["pending", "succeeded"]).toContain(refund.status);
      expect(refund.provider).toBe(h.provider);
      if (h.webhooks.refunded) {
        const event = await h.sarraf.webhooks.verifyAndParse(h.provider, h.webhooks.refunded);
        expect(event.type).toBe("refund.succeeded");
        expect(["refunded", "partially_refunded"]).toContain(event.payment.status);
      }
    });
  });
}
