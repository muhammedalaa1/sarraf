import { sha256Hex } from "./crypto.js";
import { SarrafError } from "./errors.js";
import { HttpClient, type HttpClientOptions } from "./http.js";
import { MemoryStore } from "./idempotency/memory.js";
import type { IdempotencyStore } from "./idempotency/store.js";
import { type Logger, consoleLogger, defaultLogger } from "./logger.js";
import type {
  Capabilities,
  CapabilityLevel,
  Checkout,
  CreateCheckoutInput,
  Ctx,
  Payment,
  PaymentLookup,
  PaymentProvider,
  ProviderId,
  RawWebhookRequest,
  RedirectResult,
  Refund,
  RefundInput,
  SarrafEvent,
  WebhookInspection,
} from "./types.js";
import { validateCheckoutInput, validateRefundInput } from "./validation.js";

export type ProvidersConfig = { [K in ProviderId]?: PaymentProvider<K> };

export interface SarrafOptions<P extends ProvidersConfig = ProvidersConfig> {
  providers: P;
  /** Log redacted requests and responses. */
  debug?: boolean | undefined;
  logger?: Logger | undefined;
  http?: HttpClientOptions | HttpClient | undefined;
  /** Defaults to an in-memory store. Use RedisStore from `@sarraf/core/redis` across instances. */
  idempotency?: IdempotencyStore | undefined;
  /** How long completed idempotent results are kept. Default 24h. */
  idempotencyTtlSeconds?: number | undefined;
  /** Allow calling capabilities marked "beta". Default false. */
  allowBeta?: boolean | undefined;
  now?: (() => Date) | undefined;
}

type CapabilityKey = Exclude<keyof Capabilities, "methods" | "currencies" | "checkoutKinds" | "docsUrl">;

type IdemRecord<T> =
  | { state: "in_progress"; fingerprint: string }
  | { state: "done"; fingerprint: string; result: T };

export class Sarraf<P extends ProvidersConfig = ProvidersConfig> {
  readonly ctx: Ctx;
  private readonly providers: P;
  private readonly allowBeta: boolean;
  private readonly idemTtl: number;

  constructor(options: SarrafOptions<P>) {
    if (!options?.providers || Object.keys(options.providers).length === 0) {
      throw new SarrafError("CONFIGURATION_INVALID", "Sarraf needs at least one provider in `providers`");
    }
    for (const [key, provider] of Object.entries(options.providers)) {
      if (!provider || (provider as PaymentProvider).id !== key) {
        throw new SarrafError(
          "CONFIGURATION_INVALID",
          `providers.${key} must be the ${key}() adapter (got ${(provider as PaymentProvider | undefined)?.id ?? "nothing"})`,
        );
      }
    }
    const logger = options.logger ?? (options.debug ? consoleLogger : defaultLogger);
    const http =
      options.http instanceof HttpClient
        ? options.http
        : new HttpClient({ logger, debug: options.debug, ...options.http });
    this.ctx = {
      http,
      logger,
      now: options.now ?? (() => new Date()),
      idempotency: options.idempotency ?? new MemoryStore(),
    };
    this.providers = options.providers;
    this.allowBeta = options.allowBeta ?? false;
    this.idemTtl = options.idempotencyTtlSeconds ?? 86_400;
  }

  /** The adapter registered under `id`. */
  provider<Id extends ProviderId & keyof P>(id: Id): PaymentProvider<Id> {
    const p = this.providers[id];
    if (!p) {
      throw new SarrafError(
        "CONFIGURATION_INVALID",
        `Provider "${String(id)}" is not configured. Configured: ${Object.keys(this.providers).join(", ")}`,
      );
    }
    return p as PaymentProvider<Id>;
  }

  get providerIds(): ProviderId[] {
    return Object.keys(this.providers) as ProviderId[];
  }

  capabilities(id: ProviderId & keyof P): Capabilities {
    return this.provider(id).capabilities;
  }

  readonly checkout = {
    create: async <Id extends ProviderId & keyof P>(input: CreateCheckoutInput<Id>): Promise<Checkout> => {
      const provider = this.provider(input.provider);
      this.require(provider, "checkout");
      validateCheckoutInput(input as CreateCheckoutInput);
      const caps = provider.capabilities;
      if (!caps.currencies.includes(input.amount.currency)) {
        throw new SarrafError(
          "UNSUPPORTED_CURRENCY",
          `${provider.id} does not support ${input.amount.currency} (supported: ${caps.currencies.join(", ")})`,
          { provider: provider.id, docsUrl: caps.docsUrl },
        );
      }
      for (const m of input.methods ?? []) this.requireLevel(provider, `method "${m}"`, caps.methods[m]);
      return this.idempotent(provider.id, "checkout", input.idempotencyKey, input, async () =>
        provider.createCheckout(input, this.ctx),
      );
    },
  };

  readonly payments = {
    get: async (lookup: PaymentLookup & { provider: ProviderId & keyof P }): Promise<Payment> => {
      const provider = this.provider(lookup.provider);
      this.require(provider, "getPayment");
      requireLookup(lookup);
      return provider.getPayment(stripProvider(lookup), this.ctx);
    },
    /**
     * Re-check a payment against the provider. Webhooks can be lost: run this on a schedule for
     * payments still `pending` / `awaiting_payment` after ~15 minutes.
     */
    reconcile: async (lookup: PaymentLookup & { provider: ProviderId & keyof P }): Promise<Payment> => {
      return this.payments.get(lookup);
    },
    cancel: async (lookup: PaymentLookup & { provider: ProviderId & keyof P }): Promise<Payment> => {
      const provider = this.provider(lookup.provider);
      this.require(provider, "cancel");
      requireLookup(lookup);
      if (!provider.cancel) throw notSupported(provider, "cancel");
      return provider.cancel(stripProvider(lookup), this.ctx);
    },
  };

  readonly refunds = {
    create: async (input: RefundInput & { provider: ProviderId & keyof P }): Promise<Refund> => {
      const provider = this.provider(input.provider);
      this.require(provider, "refund");
      if (input.amount) this.require(provider, "partialRefund");
      validateRefundInput(input);
      if (!provider.refund) throw notSupported(provider, "refund");
      const refund = provider.refund.bind(provider);
      const { provider: _p, ...rest } = input;
      return this.idempotent(provider.id, "refund", input.idempotencyKey, rest, async () =>
        refund(rest, this.ctx),
      );
    },
  };

  readonly webhooks = {
    /** Verify the signature and normalize the payload. Throws `WEBHOOK_SIGNATURE_INVALID`. */
    verifyAndParse: async (provider: ProviderId & keyof P, req: RawWebhookRequest): Promise<SarrafEvent> => {
      const p = this.provider(provider);
      const verified = await p.verifyWebhook(req, this.ctx);
      return p.parseWebhook(verified, this.ctx);
    },
    /** Signature diagnostics without throwing: the exact string hashed, expected vs received. */
    inspect: async (provider: ProviderId & keyof P, req: RawWebhookRequest): Promise<WebhookInspection> => {
      return this.provider(provider).inspectWebhook(req, this.ctx);
    },
    dedupeKey: (event: SarrafEvent): string => event.id,
  };

  readonly redirects = {
    /** For the thank-you page only. Order state must come from the webhook or a status query. */
    verify: async (
      provider: ProviderId & keyof P,
      query: Record<string, string>,
    ): Promise<RedirectResult> => {
      const p = this.provider(provider);
      if (!p.verifyRedirect) throw notSupported(p, "redirectVerification");
      return p.verifyRedirect(query, this.ctx);
    },
  };

  private require(provider: PaymentProvider, key: CapabilityKey) {
    this.requireLevel(provider, key, provider.capabilities[key]);
  }

  private requireLevel(provider: PaymentProvider, what: string, level: CapabilityLevel | undefined) {
    if (level === "supported") return;
    if (level === "beta") {
      if (this.allowBeta) return;
      throw new SarrafError(
        "CAPABILITY_NOT_SUPPORTED",
        `${capitalize(provider.id)} ${what} is beta in this version. Pass { allowBeta: true } to Sarraf to use it (${provider.capabilities.docsUrl})`,
        { provider: provider.id, docsUrl: provider.capabilities.docsUrl },
      );
    }
    throw notSupported(provider, what);
  }

  private async idempotent<T>(
    provider: ProviderId,
    operation: string,
    key: string | undefined,
    input: unknown,
    run: () => Promise<T>,
  ): Promise<T> {
    if (!key) return run();
    const store = this.ctx.idempotency;
    const storeKey = `${provider}:${operation}:${key}`;
    const fingerprint = sha256Hex(stableStringify(input));
    const claimed = await store.setIfAbsent(storeKey, { state: "in_progress", fingerprint }, 120);
    if (!claimed) {
      const existing = await store.get<IdemRecord<T>>(storeKey);
      if (existing && existing.fingerprint !== fingerprint) {
        throw new SarrafError(
          "INVALID_REQUEST",
          `idempotencyKey "${key}" was already used with different parameters`,
          { provider, retryable: false },
        );
      }
      if (existing?.state === "done") {
        this.ctx.logger.debug("idempotent replay", { provider, operation, key });
        return existing.result;
      }
      if (existing?.state === "in_progress") {
        throw new SarrafError(
          "INVALID_REQUEST",
          `A request with idempotencyKey "${key}" is still in progress or ended with an unknown outcome. Query the payment status.`,
          { provider, retryable: true },
        );
      }
      // Expired between calls: try again once.
      return this.idempotent(provider, operation, key, input, run);
    }
    try {
      const result = await run();
      await store.set(storeKey, { state: "done", fingerprint, result }, this.idemTtl);
      return result;
    } catch (err) {
      // Keep the lock on an unknown outcome so a blind retry cannot double-charge.
      if (!(err instanceof SarrafError && err.code === "TIMEOUT_UNKNOWN_OUTCOME"))
        await store.delete(storeKey);
      throw err;
    }
  }
}

function notSupported(provider: PaymentProvider, what: string) {
  return new SarrafError(
    "CAPABILITY_NOT_SUPPORTED",
    `${capitalize(provider.id)} does not support ${what} (${provider.capabilities.docsUrl})`,
    { provider: provider.id, docsUrl: provider.capabilities.docsUrl },
  );
}

function requireLookup(lookup: PaymentLookup) {
  if (!lookup.providerPaymentId && !lookup.reference) {
    throw new SarrafError("INVALID_REQUEST", "Pass providerPaymentId or reference");
  }
}

function stripProvider<T extends { provider: unknown }>(input: T): Omit<T, "provider"> {
  const { provider: _p, ...rest } = input;
  return rest;
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
