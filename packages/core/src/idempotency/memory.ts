import type { IdempotencyStore } from "./store.js";

/** In-process store. Fine for a single instance; use `RedisStore` when running several. */
export class MemoryStore implements IdempotencyStore {
  private readonly map = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return structuredClone(entry.value) as T;
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.map.set(key, { value: structuredClone(value), expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async setIfAbsent(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
    if ((await this.get(key)) !== undefined) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}
