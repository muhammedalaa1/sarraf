import type { ProviderId } from "./types.js";

export type SarrafErrorCode =
  | "CONFIGURATION_INVALID"
  | "AUTHENTICATION_FAILED"
  | "INVALID_REQUEST"
  | "UNSUPPORTED_CURRENCY"
  | "CAPABILITY_NOT_SUPPORTED"
  | "PAYMENT_DECLINED"
  | "DUPLICATE_REFERENCE"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  /** A money-moving call timed out. Query the payment status; do not retry blindly. */
  | "TIMEOUT_UNKNOWN_OUTCOME"
  | "WEBHOOK_SIGNATURE_INVALID"
  | "NETWORK_ERROR";

const RETRYABLE: ReadonlySet<SarrafErrorCode> = new Set([
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "NETWORK_ERROR",
]);

export interface SarrafErrorOptions {
  provider?: ProviderId | undefined;
  providerCode?: string | undefined;
  retryable?: boolean | undefined;
  raw?: unknown;
  status?: number | undefined;
  docsUrl?: string | undefined;
  cause?: unknown;
}

export class SarrafError extends Error {
  readonly code: SarrafErrorCode;
  readonly provider?: ProviderId | undefined;
  readonly providerCode?: string | undefined;
  readonly retryable: boolean;
  readonly raw?: unknown;
  readonly status?: number | undefined;
  readonly docsUrl?: string | undefined;

  constructor(code: SarrafErrorCode, message: string, options: SarrafErrorOptions = {}) {
    super(`${code}: ${message}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SarrafError";
    this.code = code;
    this.provider = options.provider;
    this.providerCode = options.providerCode;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.raw = options.raw;
    this.status = options.status;
    this.docsUrl = options.docsUrl;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      provider: this.provider,
      providerCode: this.providerCode,
      retryable: this.retryable,
      status: this.status,
      docsUrl: this.docsUrl,
    };
  }
}

export function isSarrafError(err: unknown, code?: SarrafErrorCode): err is SarrafError {
  return err instanceof SarrafError && (code === undefined || err.code === code);
}

/** Default mapping from an HTTP status to a Sarraf error code. Adapters refine it with provider codes. */
export function errorCodeForStatus(status: number): SarrafErrorCode {
  if (status === 401 || status === 403) return "AUTHENTICATION_FAILED";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "DUPLICATE_REFERENCE";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "PROVIDER_UNAVAILABLE";
  return "INVALID_REQUEST";
}
