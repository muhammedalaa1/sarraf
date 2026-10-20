import { SarrafError, errorCodeForStatus } from "./errors.js";
import { type Logger, defaultLogger } from "./logger.js";
import { redact, redactHeaders, redactUrl } from "./redact.js";
import type { ProviderId } from "./types.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string> | undefined;
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON-serialized unless it is already a string. */
  body?: unknown;
  timeoutMs?: number | undefined;
  /**
   * Moves money (create payment, refund, void). Never retried, and a timeout becomes
   * `TIMEOUT_UNKNOWN_OUTCOME` so the caller queries status instead of retrying blindly.
   */
  moneyMoving?: boolean | undefined;
  /** Safe to retry on network errors, 429 and 5xx. Defaults to true for GET. */
  retryable?: boolean | undefined;
  provider?: ProviderId | undefined;
  /** Short label for logs, e.g. "paymob.createIntention". */
  operation?: string | undefined;
}

export interface HttpResponse<T = unknown> {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  /** Parsed JSON when the body is JSON, otherwise the raw text. */
  data: T;
  text: string;
}

export interface HttpEvent {
  operation?: string | undefined;
  provider?: ProviderId | undefined;
  method: string;
  url: string;
  attempt: number;
  requestHeaders: Record<string, string>;
  requestBody?: unknown;
  status?: number | undefined;
  responseBody?: unknown;
  durationMs?: number | undefined;
  error?: string | undefined;
}

export interface HttpHooks {
  /** Called before each attempt with redacted data. */
  onRequest?(event: HttpEvent): void;
  /** Called after each attempt with redacted data. */
  onResponse?(event: HttpEvent): void;
}

export interface HttpClientOptions {
  fetch?: FetchLike | undefined;
  timeoutMs?: number | undefined;
  /** Retries for retryable requests (GET / status calls). Default 2. */
  maxRetries?: number | undefined;
  hooks?: HttpHooks | undefined;
  logger?: Logger | undefined;
  debug?: boolean | undefined;
  /** Injected for tests. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

const defaultSleep = async (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly hooks: HttpHooks;
  private readonly logger: Logger;
  private readonly debug: boolean;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: HttpClientOptions = {}) {
    const f = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) throw new SarrafError("CONFIGURATION_INVALID", "No fetch implementation found. Use Node 18+.");
    this.fetchImpl = f;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.hooks = options.hooks ?? {};
    this.logger = options.logger ?? defaultLogger;
    this.debug = options.debug ?? false;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>> {
    const url = buildUrl(req.url, req.query);
    const headers: Record<string, string> = { accept: "application/json", ...req.headers };
    let body: string | undefined;
    if (req.body !== undefined) {
      body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
        headers["content-type"] = "application/json";
      }
    }
    const retryable = !req.moneyMoving && (req.retryable ?? req.method === "GET");
    const maxAttempts = retryable ? this.maxRetries + 1 : 1;

    for (let attempt = 1; ; attempt++) {
      const event: HttpEvent = {
        operation: req.operation,
        provider: req.provider,
        method: req.method,
        url: redactUrl(url),
        attempt,
        requestHeaders: redactHeaders(headers),
        requestBody: req.body === undefined ? undefined : redact(req.body),
      };
      this.emit("onRequest", event);
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? this.timeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: req.method,
          headers,
          signal: controller.signal,
          ...(body === undefined ? {} : { body }),
        });
      } catch (err) {
        clearTimeout(timer);
        const timedOut = controller.signal.aborted;
        this.emit("onResponse", {
          ...event,
          durationMs: Date.now() - started,
          error: timedOut ? "timeout" : String(err),
        });
        if (req.moneyMoving) {
          throw new SarrafError(
            "TIMEOUT_UNKNOWN_OUTCOME",
            `${req.operation ?? req.method} ${timedOut ? "timed out" : "failed on the network"}; the provider may or may not have processed it. Query the payment status before retrying.`,
            { provider: req.provider, retryable: false, cause: err },
          );
        }
        if (attempt < maxAttempts) {
          await this.sleep(backoff(attempt));
          continue;
        }
        throw new SarrafError(
          "NETWORK_ERROR",
          `${req.operation ?? req.method} ${timedOut ? "timed out" : "network error"}`,
          { provider: req.provider, cause: err },
        );
      }
      const text = await res.text().finally(() => clearTimeout(timer));
      const data = parseBody(text);
      const responseHeaders = headersToRecord(res.headers);
      this.emit("onResponse", {
        ...event,
        status: res.status,
        responseBody: redact(data),
        durationMs: Date.now() - started,
      });
      if (retryable && attempt < maxAttempts && (res.status === 429 || res.status >= 500)) {
        await this.sleep(retryAfterMs(responseHeaders["retry-after"]) ?? backoff(attempt));
        continue;
      }
      return { status: res.status, ok: res.ok, headers: responseHeaders, data: data as T, text };
    }
  }

  private emit(hook: keyof HttpHooks, event: HttpEvent) {
    if (this.debug) {
      this.logger.debug(`${hook === "onRequest" ? "→" : "←"} ${event.method} ${event.url}`, { ...event });
    }
    try {
      this.hooks[hook]?.(event);
    } catch (err) {
      this.logger.warn(`http ${hook} hook threw`, { error: String(err) });
    }
  }
}

/** Throw a SarrafError for a non-2xx response using the default status mapping. */
export function ensureOk<T>(
  res: HttpResponse<T>,
  provider: ProviderId,
  operation: string,
  providerMessage?: (data: unknown) => string | undefined,
): HttpResponse<T> {
  if (res.ok) return res;
  const detail = providerMessage?.(res.data) ?? (typeof res.data === "string" ? res.data.slice(0, 200) : "");
  throw new SarrafError(
    errorCodeForStatus(res.status),
    `${provider} ${operation} failed with HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    { provider, status: res.status, raw: redact(res.data) },
  );
}

export function buildUrl(base: string, query?: HttpRequest["query"]): string {
  if (!query) return base;
  const u = new URL(base);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
  return u.toString();
}

function parseBody(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

function backoff(attempt: number): number {
  return Math.min(200 * 2 ** (attempt - 1), 2000) + Math.floor(Math.random() * 100);
}

function retryAfterMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, 10_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(Math.max(date - Date.now(), 0), 10_000) : undefined;
}
