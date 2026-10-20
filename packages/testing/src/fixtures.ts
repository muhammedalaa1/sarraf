import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * A recorded, scrubbed sandbox exchange. See scripts/record-fixtures.ts.
 * `secret` is a throwaway test secret used to re-sign `webhook` so tests can verify it.
 */
export interface Fixture<T = unknown> {
  provider: string;
  scenario: string;
  /** "sandbox" when recorded from a real sandbox, "synthetic" when hand-written from docs. */
  source: "sandbox" | "synthetic";
  recordedAt?: string | undefined;
  description?: string | undefined;
  request?: unknown;
  response?: unknown;
  webhook?: {
    headers?: Record<string, string> | undefined;
    query?: Record<string, string> | undefined;
    rawBody: string;
  };
  /** Throwaway secret used to compute `expectedSignature`. */
  secret?: string | undefined;
  expectedSignature?: string | undefined;
  /** The exact string that the signature covers, for documentation. */
  signedString?: string | undefined;
  data?: T | undefined;
}

/** Find the repo's fixtures/ directory by walking up from `start`. */
export function findFixturesDir(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, "fixtures");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`No fixtures/ directory found above ${start}`);
    dir = parent;
  }
}

export function loadFixture<T = unknown>(
  provider: string,
  scenario: string,
  root = findFixturesDir(),
): Fixture<T> {
  const file = join(root, provider, `${scenario}.json`);
  if (!existsSync(file)) throw new Error(`Fixture not found: ${file}`);
  return JSON.parse(readFileSync(file, "utf8")) as Fixture<T>;
}

export function listFixtures(provider: string, root = findFixturesDir()): string[] {
  const dir = join(root, provider);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}
