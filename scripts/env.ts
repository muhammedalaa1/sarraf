import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SarrafError } from "@sarraf/core";
import { config } from "dotenv";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ENV_FILE = resolve(ROOT, ".env.sandbox");

/** Load .env.sandbox (if present) into process.env. */
export function loadSandboxEnv(): boolean {
  if (!existsSync(ENV_FILE)) return false;
  config({ path: ENV_FILE, override: false, quiet: true } as Parameters<typeof config>[0]);
  return true;
}

export function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

export function requireEnv(...names: string[]): Record<string, string> {
  const missing = names.filter((n) => !env(n));
  if (missing.length) {
    throw new SarrafError("CONFIGURATION_INVALID", `Missing ${missing.join(", ")} in .env.sandbox`);
  }
  return Object.fromEntries(names.map((n) => [n, env(n)!]));
}

/** Refuse anything that looks like a live credential. */
export function assertSandbox(name: string, value: string | undefined) {
  if (value && /(_live_|live_)/i.test(value)) {
    throw new SarrafError(
      "CONFIGURATION_INVALID",
      `${name} looks like a LIVE key. Sandbox credentials only.`,
    );
  }
}

export function hasPaymob() {
  return Boolean(env("PAYMOB_SECRET_KEY") && env("PAYMOB_PUBLIC_KEY") && env("PAYMOB_HMAC_SECRET"));
}
export function hasKashier() {
  return Boolean(env("KASHIER_MERCHANT_ID") && env("KASHIER_API_KEY"));
}
export function hasFawry() {
  return Boolean(env("FAWRY_MERCHANT_CODE") && env("FAWRY_SECURE_KEY"));
}
