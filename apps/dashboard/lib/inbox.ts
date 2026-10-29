import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ProviderId, SarrafEvent, WebhookInspection } from "@sarrafjs/core";

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;

export interface InboxEntry {
  id: string;
  provider: ProviderId;
  receivedAt: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  rawBody: string;
  inspection: WebhookInspection;
  event?: SarrafEvent | undefined;
  error?: string | undefined;
  replays: number;
}

/**
 * Tiny JSON-file store for captured sandbox webhooks. Entries older than 7 days are pruned on
 * every write. Sandbox data only.
 */
export class Inbox {
  constructor(
    private readonly file = resolve(process.cwd(), "data", "inbox.json"),
    private readonly now: () => number = Date.now,
  ) {}

  list(): InboxEntry[] {
    if (!existsSync(this.file)) return [];
    try {
      const entries = JSON.parse(readFileSync(this.file, "utf8")) as InboxEntry[];
      return entries.filter((e) => this.now() - Date.parse(e.receivedAt) < RETENTION_MS);
    } catch {
      return [];
    }
  }

  get(id: string): InboxEntry | undefined {
    return this.list().find((e) => e.id === id);
  }

  add(entry: Omit<InboxEntry, "id" | "receivedAt" | "replays">): InboxEntry {
    const full: InboxEntry = {
      ...entry,
      id: randomUUID(),
      receivedAt: new Date(this.now()).toISOString(),
      replays: 0,
    };
    this.save([full, ...this.list()].slice(0, MAX_ENTRIES));
    return full;
  }

  update(id: string, patch: Partial<InboxEntry>): InboxEntry | undefined {
    let updated: InboxEntry | undefined;
    this.save(
      this.list().map((e) => {
        if (e.id !== id) return e;
        updated = { ...e, ...patch };
        return updated;
      }),
    );
    return updated;
  }

  clear() {
    this.save([]);
  }

  private save(entries: InboxEntry[]) {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries));
    renameSync(tmp, this.file);
  }
}

const g = globalThis as unknown as { __inbox?: Inbox };
g.__inbox ??= new Inbox();
export const inbox = g.__inbox;
