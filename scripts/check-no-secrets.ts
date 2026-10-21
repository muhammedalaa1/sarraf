/**
 * Fail if anything that looks like a real credential is in the repository.
 * - generic key patterns (live/test keys, private keys, JWT-like tokens)
 * - every value from .env.sandbox (when present locally) must not appear in any tracked file
 *
 * Usage: pnpm check-secrets
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";
import { ENV_FILE, isPlaceholder, ROOT } from "./env.js";

const PATTERNS: [string, RegExp][] = [
  ["Paymob/Stripe-style live key", /\b(sk|pk)_live_[A-Za-z0-9]{8,}/],
  ["Paymob test secret key", /\bsk_test_[A-Za-z0-9]{24,}/],
  ["Private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Long JWT / Paymob legacy API key", /\beyJ[A-Za-z0-9_-]{60,}\.[A-Za-z0-9_-]{20,}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
];

const SKIP = /(^|\/)(node_modules|dist|\.next|\.turbo|coverage|\.git)\//;
const BINARY = /\.(png|jpe?g|gif|ico|woff2?|ttf|lock|pdf|zip)$/i;

function files(): string[] {
  try {
    const out = execSync("git ls-files --cached --others --exclude-standard", {
      cwd: ROOT,
      encoding: "utf8",
    });
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function sandboxValues(): [string, string][] {
  if (!existsSync(ENV_FILE)) return [];
  const parsed = parse(readFileSync(ENV_FILE));
  return Object.entries(parsed).filter(
    ([k, v]) =>
      v.length >= 8 &&
      !isPlaceholder(v) &&
      !/(URL|REGION|INTEGRATION_ID|_ID$|_REFERENCE$)/.test(k) &&
      !/^https?:/.test(v),
  );
}

const values = sandboxValues();
const problems: string[] = [];
for (const file of files()) {
  if (SKIP.test(file) || BINARY.test(file) || file === ".env.sandbox") continue;
  const path = join(ROOT, file);
  if (!existsSync(path) || statSync(path).size > 2_000_000) continue;
  const text = readFileSync(path, "utf8");
  for (const [name, re] of PATTERNS) {
    const m = re.exec(text);
    if (m) problems.push(`${file}: ${name} (${m[0].slice(0, 12)}…)`);
  }
  for (const [k, v] of values) {
    if (text.includes(v)) problems.push(`${file}: contains the value of ${k} from .env.sandbox`);
  }
}

if (problems.length) {
  console.error(`✗ Possible secrets found:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(
  `✓ No secrets found (${values.length ? `checked ${values.length} sandbox values + ` : ""}patterns).`,
);
