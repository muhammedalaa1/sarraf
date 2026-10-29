import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Money, Payment, ProviderId } from "@sarrafjs/core";

export type OrderAction = "checkout" | "reconcile" | "refund" | "cancel" | "capture" | "webhook";

export interface OrderHistoryItem {
  at: string;
  action: OrderAction;
  ok: boolean;
  summary: string;
}

export interface Order {
  /** `<provider>:<reference>` */
  key: string;
  provider: ProviderId;
  reference: string;
  amount?: Money | undefined;
  redirectUrl?: string | undefined;
  referenceCode?: string | undefined;
  createdAt: string;
  /** Latest normalized payment, without `raw`. */
  payment?: Omit<Payment, "raw"> | undefined;
  history: OrderHistoryItem[];
}

const MAX_ORDERS = 200;
const MAX_HISTORY = 50;

/**
 * Orders created or looked up from the dashboard, so reconcile / refund / void can be run on them
 * later. Same JSON-file approach as the inbox. Sandbox data only.
 */
export class Orders {
  constructor(
    private readonly file = resolve(process.cwd(), "data", "orders.json"),
    private readonly now: () => number = Date.now,
  ) {}

  list(): Order[] {
    if (!existsSync(this.file)) return [];
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as Order[];
    } catch {
      return [];
    }
  }

  get(provider: ProviderId, reference: string): Order | undefined {
    return this.list().find((o) => o.key === orderKey(provider, reference));
  }

  /** Creates the order if needed, applies `patch` and appends `event` to its history. */
  upsert(
    provider: ProviderId,
    reference: string,
    patch: Partial<Omit<Order, "key" | "provider" | "reference" | "history">>,
    event?: Omit<OrderHistoryItem, "at">,
  ): Order {
    const key = orderKey(provider, reference);
    const all = this.list();
    const existing = all.find((o) => o.key === key);
    const base: Order = existing ?? {
      key,
      provider,
      reference,
      createdAt: new Date(this.now()).toISOString(),
      history: [],
    };
    const history = event
      ? [{ ...event, at: new Date(this.now()).toISOString() }, ...base.history].slice(0, MAX_HISTORY)
      : base.history;
    const next: Order = { ...base, ...stripUndefined(patch), history };
    this.save([next, ...all.filter((o) => o.key !== key)].slice(0, MAX_ORDERS));
    return next;
  }

  remove(provider: ProviderId, reference: string) {
    const key = orderKey(provider, reference);
    this.save(this.list().filter((o) => o.key !== key));
  }

  clear() {
    this.save([]);
  }

  private save(orders: Order[]) {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(orders));
    renameSync(tmp, this.file);
  }
}

export function orderKey(provider: ProviderId, reference: string): string {
  return `${provider}:${reference}`;
}

export function withoutRaw(payment: Payment): Omit<Payment, "raw"> {
  const { raw: _raw, ...rest } = payment;
  return rest;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const g = globalThis as unknown as { __orders?: Orders };
g.__orders ??= new Orders();
export const orders = g.__orders;
