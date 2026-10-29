import { sha256Hex } from "../crypto.js";
import { SarrafError } from "../errors.js";
import type { Ctx, ProviderId } from "../types.js";

type IdemRecord<T> =
  | { state: "in_progress"; fingerprint: string }
  | { state: "done"; fingerprint: string; result: T };

export interface IdempotentCall<T> {
  provider: ProviderId;
  /** Short label, e.g. "refund" or "cards.charge". Part of the store key. */
  operation: string;
  /** No key means no idempotency: `run` is called directly. */
  key: string | undefined;
  /** The request parameters. Reusing a key with different parameters is rejected. */
  input: unknown;
  /** How long a completed result is replayed. */
  ttlSeconds: number;
  run: () => Promise<T>;
}

/**
 * Run a money-moving call at most once per idempotency key, replaying the stored result on retry.
 * Used by `Sarraf` and by adapter extras (e.g. charging a saved card).
 */
export async function runIdempotent<T>(
  ctx: Pick<Ctx, "idempotency" | "logger">,
  call: IdempotentCall<T>,
): Promise<T> {
  const { provider, operation, key, input, run } = call;
  if (!key) return run();
  const store = ctx.idempotency;
  const storeKey = `${provider}:${operation}:${key}`;
  const fingerprint = sha256Hex(stableStringify(input));
  const claimed = await store.setIfAbsent(storeKey, { state: "in_progress", fingerprint }, 120);
  if (!claimed) {
    const existing = await store.get<IdemRecord<T>>(storeKey);
    if (existing && existing.fingerprint !== fingerprint) {
      throw new SarrafError(
        "INVALID_REQUEST",
        `idempotencyKey "${key}" was already used with different parameters`,
        {
          provider,
          retryable: false,
        },
      );
    }
    if (existing?.state === "done") {
      ctx.logger.debug("idempotent replay", { provider, operation, key });
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
    return runIdempotent(ctx, call);
  }
  try {
    const result = await run();
    await store.set(storeKey, { state: "done", fingerprint, result }, call.ttlSeconds);
    return result;
  } catch (err) {
    // Keep the lock on an unknown outcome so a blind retry cannot double-charge.
    if (!(err instanceof SarrafError && err.code === "TIMEOUT_UNKNOWN_OUTCOME")) await store.delete(storeKey);
    throw err;
  }
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
