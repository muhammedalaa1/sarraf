/**
 * Storage for idempotent results of money-moving calls (`checkout.create`, `refunds.create`).
 * Values are JSON-serializable.
 */
export interface IdempotencyStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  /** Set only if the key is absent. Returns true when the value was written (acts as a lock). */
  setIfAbsent(key: string, value: unknown, ttlSeconds: number): Promise<boolean>;
  delete(key: string): Promise<void>;
}
