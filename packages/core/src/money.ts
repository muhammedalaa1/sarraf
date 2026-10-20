import { SarrafError } from "./errors.js";
import type { Currency, Money } from "./types.js";

/** Number of minor-unit digits per currency (ISO 4217). */
export const CURRENCY_EXPONENT: Readonly<Record<Currency, number>> = {
  EGP: 2,
  SAR: 2,
  AED: 2,
  QAR: 2,
  USD: 2,
  EUR: 2,
  KWD: 3,
  BHD: 3,
  OMR: 3,
  JOD: 3,
};

export const CURRENCIES = Object.keys(CURRENCY_EXPONENT) as Currency[];

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && Object.hasOwn(CURRENCY_EXPONENT, value);
}

export function exponentOf(currency: Currency): number {
  const exp = CURRENCY_EXPONENT[currency];
  if (exp === undefined) throw new SarrafError("UNSUPPORTED_CURRENCY", `Unknown currency "${currency}"`);
  return exp;
}

const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;

/**
 * Convert a major-unit amount to integer minor units with string math (no float division).
 * `toMinor("250.00", "EGP") === 25000`, `toMinor("1.250", "KWD") === 1250`.
 * Throws if the value has more precision than the currency allows (non-zero extra digits).
 */
export function toMinor(major: string | number, currency: Currency): number {
  const exp = exponentOf(currency);
  let text: string;
  if (typeof major === "number") {
    if (!Number.isFinite(major)) throw invalid(major, currency);
    // Shortest round-trip representation; avoids binary float noise like 0.1 + 0.2.
    text = numberToPlainString(major);
  } else {
    text = major.trim();
  }
  const m = DECIMAL.exec(text);
  if (!m) throw invalid(major, currency);
  const [, sign, intPart = "0", fracRaw = ""] = m;
  const extra = fracRaw.slice(exp);
  if (/[1-9]/.test(extra)) {
    throw new SarrafError(
      "INVALID_REQUEST",
      `Amount "${text}" has more than ${exp} decimal places for ${currency}`,
    );
  }
  const frac = fracRaw.slice(0, exp).padEnd(exp, "0");
  const minor = BigInt(intPart + frac) * (sign ? -1n : 1n);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER) || minor < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new SarrafError("INVALID_REQUEST", `Amount "${text}" is too large`);
  }
  return Number(minor);
}

/**
 * Format integer minor units as a major-unit string with exactly the currency's decimals.
 * `toMajorString(25000, "EGP") === "250.00"`, `toMajorString(1250, "KWD") === "1.250"`.
 */
export function toMajorString(minor: number, currency: Currency): string {
  return toMajorFixed(minor, currency, exponentOf(currency));
}

/**
 * Format minor units with a fixed number of decimals (e.g. Fawry always wants 2).
 * Throws instead of silently rounding when `decimals` is smaller than needed.
 */
export function toMajorFixed(minor: number, currency: Currency, decimals: number): string {
  assertInteger(minor);
  const exp = exponentOf(currency);
  const negative = minor < 0;
  const digits = Math.abs(minor)
    .toString()
    .padStart(exp + 1, "0");
  const intPart = digits.slice(0, digits.length - exp) || "0";
  let frac = digits.slice(digits.length - exp);
  if (decimals < exp) {
    const dropped = frac.slice(decimals);
    if (/[1-9]/.test(dropped)) {
      throw new SarrafError(
        "INVALID_REQUEST",
        `Cannot format ${minor} ${currency} minor units with ${decimals} decimals without rounding`,
      );
    }
    frac = frac.slice(0, decimals);
  } else {
    frac = frac.padEnd(decimals, "0");
  }
  return `${negative ? "-" : ""}${intPart}${decimals > 0 ? `.${frac}` : ""}`;
}

/** Major-unit string with trailing fractional zeros removed: 25000 EGP → "250", 25050 → "250.5". */
export function toMajorTrimmed(minor: number, currency: Currency): string {
  const fixed = toMajorString(minor, currency);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/**
 * Re-format a decimal amount string or number to exactly `decimals` places using string math.
 * Used where a provider sends `250` and its signature expects `"250.00"`.
 */
export function normalizeDecimal(value: string | number, decimals: number): string {
  const text = typeof value === "number" ? numberToPlainString(value) : value.trim();
  const m = DECIMAL.exec(text);
  if (!m) throw new SarrafError("INVALID_REQUEST", `"${String(value)}" is not a decimal amount`);
  const [, sign = "", intPart = "0", fracRaw = ""] = m;
  if (/[1-9]/.test(fracRaw.slice(decimals))) {
    throw new SarrafError("INVALID_REQUEST", `"${text}" has more than ${decimals} decimal places`);
  }
  const frac = fracRaw.slice(0, decimals).padEnd(decimals, "0");
  const int = intPart.replace(/^0+(?=\d)/, "");
  return `${sign}${int}${decimals > 0 ? `.${frac}` : ""}`;
}

export function money(value: number, currency: Currency): Money {
  const m = { value, currency };
  assertMoney(m);
  return m;
}

export function zero(currency: Currency): Money {
  return { value: 0, currency };
}

export function assertMoney(m: Money, field = "amount"): void {
  if (!m || typeof m !== "object")
    throw new SarrafError("INVALID_REQUEST", `${field} must be a Money object`);
  if (!isCurrency(m.currency)) {
    throw new SarrafError(
      "UNSUPPORTED_CURRENCY",
      `${field}.currency "${String(m.currency)}" is not supported`,
    );
  }
  if (!Number.isSafeInteger(m.value) || m.value < 0) {
    throw new SarrafError(
      "INVALID_REQUEST",
      `${field}.value must be a non-negative integer in minor units (got ${String(m.value)}). ` +
        `250.00 ${m.currency} is ${toMinor("250", m.currency)}.`,
    );
  }
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new SarrafError("INVALID_REQUEST", `Cannot add ${a.currency} and ${b.currency}`);
  }
  return { value: a.value + b.value, currency: a.currency };
}

function assertInteger(minor: number) {
  if (!Number.isSafeInteger(minor)) {
    throw new SarrafError("INVALID_REQUEST", `Minor units must be a safe integer (got ${String(minor)})`);
  }
}

function invalid(value: unknown, currency: Currency) {
  return new SarrafError("INVALID_REQUEST", `"${String(value)}" is not a valid ${currency} amount`);
}

function numberToPlainString(n: number): string {
  const s = String(n);
  if (!/e/i.test(s)) return s;
  // Expand exponent notation without float math.
  const [mantissa = "0", expStr = "0"] = s.toLowerCase().split("e");
  const exp = Number(expStr);
  const negative = mantissa.startsWith("-");
  const [i = "0", f = ""] = mantissa.replace("-", "").split(".");
  const digits = i + f;
  const point = i.length + exp;
  let out: string;
  if (point <= 0) out = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) out = digits + "0".repeat(point - digits.length);
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return (negative ? "-" : "") + out;
}
