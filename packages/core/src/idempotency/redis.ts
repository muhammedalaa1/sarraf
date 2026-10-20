import type { IdempotencyStore } from "./store.js";

/** The subset of the ioredis / node-redis v4 API that RedisStore needs. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/**
 * Redis-backed idempotency store. Bring your own client (ioredis or node-redis):
 *
 * ```ts
 * import Redis from "ioredis";
 * import { RedisStore } from "@sarraf/core/redis";
 * const idempotency = new RedisStore(new Redis(process.env.REDIS_URL));
 * ```
 */
export class RedisStore implements IdempotencyStore {
  constructor(
    private readonly redis: RedisLike,
    private readonly prefix = "sarraf:idem:",
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.redis.get(this.prefix + key);
    return raw == null ? undefined : (JSON.parse(raw) as T);
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.redis.set(this.prefix + key, JSON.stringify(value), "EX", Math.ceil(ttlSeconds));
  }

  async setIfAbsent(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
    const res = await this.redis.set(
      this.prefix + key,
      JSON.stringify(value),
      "EX",
      Math.ceil(ttlSeconds),
      "NX",
    );
    return res === "OK";
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(this.prefix + key);
  }
}
