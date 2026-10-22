import {
  buildEvent,
  type Capabilities,
  type Checkout,
  type CreateCheckoutInput,
  hmacHex,
  normalizeHeaders,
  type Payment,
  type PaymentLookup,
  type PaymentProvider,
  type PaymentStatus,
  type ProviderId,
  parseJsonBody,
  type RawWebhookRequest,
  type Refund,
  type RefundInput,
  rawBodyToString,
  refundedStatus,
  SarrafError,
  safeEqualHex,
  sarrafId,
} from "@sarrafjs/core";

export interface FakeProviderOptions {
  /** Secret used to sign simulated webhooks. Default "fake_secret". */
  secret?: string | undefined;
  capabilities?: Partial<Capabilities> | undefined;
  checkoutKind?: "redirect" | "reference_code" | undefined;
  /**
   * Where redirect checkouts send the customer: `<redirectBaseUrl>/<providerPaymentId>?reference=…`.
   * Point it at a page in your app to click through a fake hosted checkout. Default
   * "https://fake.sarraf.dev/pay" (not a real page).
   */
  redirectBaseUrl?: string | undefined;
}

export interface FakeProvider<Id extends ProviderId> extends PaymentProvider<Id> {
  /** Move a payment to `status` and return a signed webhook request for it. */
  simulate(reference: string, status: PaymentStatus): RawWebhookRequest;
  payments: Map<string, Payment>;
}

const HEADER = "x-sarraf-fake-signature";

/**
 * An in-memory provider for testing merchant code without network calls. It can stand in for
 * any provider id so the rest of your app does not change.
 */
export function fakeProvider<Id extends ProviderId>(
  id: Id,
  options: FakeProviderOptions = {},
): FakeProvider<Id> {
  const secret = options.secret ?? "fake_secret";
  const kind = options.checkoutKind ?? "redirect";
  const redirectBaseUrl = (options.redirectBaseUrl ?? "https://fake.sarraf.dev/pay").replace(/\/+$/, "");
  const payments = new Map<string, Payment>();
  let seq = 0;

  const find = (lookup: PaymentLookup): Payment => {
    const p = lookup.reference
      ? payments.get(lookup.reference)
      : [...payments.values()].find((x) => x.providerPaymentId === lookup.providerPaymentId);
    if (!p) throw new SarrafError("NOT_FOUND", `fake ${id}: payment not found`, { provider: id });
    return p;
  };

  const capabilities: Capabilities = {
    checkout: "supported",
    getPayment: "supported",
    refund: "supported",
    partialRefund: "supported",
    cancel: "supported",
    webhooks: "supported",
    redirectVerification: "unsupported",
    methods: { card: "supported", wallet: "supported", cash_outlet: "supported" },
    currencies: ["EGP", "SAR", "AED", "KWD", "USD"],
    checkoutKinds: [kind],
    docsUrl: "https://sarraf.dev/testing",
    ...options.capabilities,
  };

  const sign = (body: string) => hmacHex("sha256", secret, body);

  const provider: FakeProvider<Id> = {
    id,
    capabilities,
    payments,

    async createCheckout(input: CreateCheckoutInput<Id>, ctx): Promise<Checkout> {
      if (payments.has(input.reference)) {
        throw new SarrafError("DUPLICATE_REFERENCE", `fake ${id}: reference already used`, { provider: id });
      }
      const providerPaymentId = String(++seq);
      const now = ctx.now().toISOString();
      const payment: Payment = {
        id: sarrafId(id, providerPaymentId),
        provider: id,
        providerPaymentId,
        reference: input.reference,
        status: kind === "reference_code" ? "awaiting_payment" : "pending",
        amount: input.amount,
        amountRefunded: { value: 0, currency: input.amount.currency },
        createdAt: now,
        updatedAt: now,
        raw: { fake: true },
      };
      payments.set(input.reference, payment);
      return {
        id: sarrafId(id, `chk${providerPaymentId}`),
        provider: id,
        kind,
        ...(kind === "redirect"
          ? {
              redirectUrl: `${redirectBaseUrl}/${providerPaymentId}?reference=${encodeURIComponent(input.reference)}`,
            }
          : {
              referenceCode: `9${providerPaymentId.padStart(8, "0")}`,
              expiresAt: new Date(
                ctx.now().getTime() + (input.expiresInSeconds ?? 86_400) * 1000,
              ).toISOString(),
            }),
        payment: structuredClone(payment),
        raw: { fake: true },
      };
    },

    async getPayment(lookup) {
      return structuredClone(find(lookup));
    },

    async refund(input: RefundInput): Promise<Refund> {
      const p = find({ providerPaymentId: input.providerPaymentId });
      if (p.status !== "succeeded" && p.status !== "partially_refunded") {
        throw new SarrafError("INVALID_REQUEST", `fake ${id}: only paid payments can be refunded`, {
          provider: id,
        });
      }
      const amount = input.amount ?? {
        value: p.amount.value - p.amountRefunded.value,
        currency: p.amount.currency,
      };
      p.amountRefunded = { value: p.amountRefunded.value + amount.value, currency: p.amount.currency };
      p.status = refundedStatus(p.amount, p.amountRefunded);
      return {
        id: sarrafId(id, `re${++seq}`),
        provider: id,
        providerPaymentId: p.providerPaymentId,
        status: "succeeded",
        amount,
        payment: structuredClone(p),
        raw: { fake: true },
      };
    },

    async cancel(lookup) {
      const p = find(lookup);
      p.status = "canceled";
      return structuredClone(p);
    },

    async inspectWebhook(req) {
      const body = rawBodyToString(req.rawBody);
      const received = normalizeHeaders(req.headers)[HEADER];
      const expected = sign(body);
      return {
        valid: safeEqualHex(expected, received),
        signedString: body,
        expected,
        received,
        algorithm: "HMAC-SHA256(rawBody)",
        reason: received ? undefined : `missing ${HEADER} header`,
      };
    },

    async verifyWebhook(req, ctx) {
      const inspection = await provider.inspectWebhook(req, ctx);
      if (!inspection.valid) {
        throw new SarrafError("WEBHOOK_SIGNATURE_INVALID", `fake ${id} signature mismatch`, { provider: id });
      }
      return {
        provider: id,
        body: parseJsonBody(id, req.rawBody),
        headers: normalizeHeaders(req.headers),
        query: {},
      };
    },

    async parseWebhook(verified, ctx) {
      const payment = verified.body as Payment;
      return buildEvent({
        provider: id,
        providerEventId: payment.providerPaymentId,
        payment,
        receivedAt: ctx.now(),
        raw: verified.body,
      });
    },

    simulate(reference, status) {
      const p = payments.get(reference);
      if (!p) throw new Error(`fake ${id}: unknown reference ${reference}`);
      p.status = status;
      if (status === "refunded") p.amountRefunded = { ...p.amount };
      const rawBody = JSON.stringify(p);
      return { rawBody, headers: { [HEADER]: sign(rawBody), "content-type": "application/json" } };
    },
  };
  return provider;
}
