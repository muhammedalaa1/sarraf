import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addMoney,
  assertMoney,
  CURRENCIES,
  exponentOf,
  isCurrency,
  money,
  normalizeDecimal,
  toMajorFixed,
  toMajorString,
  toMajorTrimmed,
  toMinor,
  zero,
} from "../src/money.js";
import type { Currency } from "../src/types.js";

describe("toMinor / toMajorString", () => {
  it("handles the documented examples", () => {
    expect(toMinor("250.00", "EGP")).toBe(25000);
    expect(toMajorString(25000, "EGP")).toBe("250.00");
    expect(toMinor("1.250", "KWD")).toBe(1250);
    expect(toMajorString(1250, "KWD")).toBe("1.250");
  });

  it("uses 3 decimals for KWD, BHD, OMR, JOD", () => {
    for (const c of ["KWD", "BHD", "OMR", "JOD"] as Currency[]) {
      expect(exponentOf(c)).toBe(3);
      expect(toMajorString(1, c)).toBe("0.001");
    }
  });

  it("accepts numbers without float noise", () => {
    expect(toMinor(0.3, "EGP")).toBe(30);
    expect(toMinor(19.99, "EGP")).toBe(1999);
    expect(toMinor(250, "EGP")).toBe(25000);
    expect(toMinor(1e21 / 1e21, "EGP")).toBe(100);
    expect(toMinor(1e-7 * 0, "EGP")).toBe(0);
  });

  it("expands exponent notation", () => {
    expect(toMinor(1e-3, "KWD")).toBe(1);
    expect(toMinor(1.5e3, "EGP")).toBe(150000);
  });

  it("allows trailing zeros beyond the exponent but rejects extra precision", () => {
    expect(toMinor("10.5000", "EGP")).toBe(1050);
    expect(() => toMinor("10.505", "EGP")).toThrow(/more than 2 decimal/);
  });

  it("rejects garbage", () => {
    expect(() => toMinor("abc", "EGP")).toThrow();
    expect(() => toMinor("1,000.00", "EGP")).toThrow();
    expect(() => toMinor(Number.NaN, "EGP")).toThrow();
    expect(() => toMinor("1".repeat(20), "EGP")).toThrow(/too large/);
    expect(() => exponentOf("XXX" as Currency)).toThrow(/Unknown currency/);
  });

  it("handles negatives and small values", () => {
    expect(toMinor("-1.50", "EGP")).toBe(-150);
    expect(toMajorString(-150, "EGP")).toBe("-1.50");
    expect(toMajorString(5, "EGP")).toBe("0.05");
    expect(toMajorString(0, "KWD")).toBe("0.000");
  });

  it("round-trips every currency (property)", () => {
    for (const currency of CURRENCIES) {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (minor) => {
          expect(toMinor(toMajorString(minor, currency), currency)).toBe(minor);
        }),
        { numRuns: 200 },
      );
    }
  });
});

describe("formatting helpers", () => {
  it("toMajorFixed pads and refuses to round", () => {
    expect(toMajorFixed(25000, "EGP", 2)).toBe("250.00");
    expect(toMajorFixed(1250, "KWD", 4)).toBe("1.2500");
    expect(toMajorFixed(1250, "KWD", 2)).toBe("1.25");
    expect(() => toMajorFixed(1255, "KWD", 2)).toThrow(/without rounding/);
    expect(toMajorFixed(100, "EGP", 0)).toBe("1");
    expect(() => toMajorFixed(1.5, "EGP", 2)).toThrow(/safe integer/);
  });

  it("toMajorTrimmed removes trailing zeros", () => {
    expect(toMajorTrimmed(25000, "EGP")).toBe("250");
    expect(toMajorTrimmed(25050, "EGP")).toBe("250.5");
    expect(toMajorTrimmed(25055, "EGP")).toBe("250.55");
  });

  it("normalizeDecimal fixes JSON-parsed amounts for signatures", () => {
    expect(normalizeDecimal(250, 2)).toBe("250.00");
    expect(normalizeDecimal("250.5", 2)).toBe("250.50");
    expect(normalizeDecimal("0250.00", 2)).toBe("250.00");
    expect(normalizeDecimal(" 7 ", 0)).toBe("7");
    expect(() => normalizeDecimal("250.555", 2)).toThrow();
    expect(() => normalizeDecimal("x", 2)).toThrow();
  });
});

describe("Money objects", () => {
  it("validates", () => {
    expect(money(100, "EGP")).toEqual({ value: 100, currency: "EGP" });
    expect(zero("SAR")).toEqual({ value: 0, currency: "SAR" });
    expect(() => assertMoney({ value: 1.5, currency: "EGP" })).toThrow(/minor units/);
    expect(() => assertMoney({ value: -1, currency: "EGP" })).toThrow();
    expect(() => assertMoney({ value: 1, currency: "XYZ" as Currency })).toThrow(/not supported/);
    expect(() => assertMoney(null as never)).toThrow(/Money object/);
    expect(isCurrency("EGP")).toBe(true);
    expect(isCurrency("toString")).toBe(false);
  });

  it("adds same-currency amounts only", () => {
    expect(addMoney(money(1, "EGP"), money(2, "EGP"))).toEqual(money(3, "EGP"));
    expect(() => addMoney(money(1, "EGP"), money(2, "SAR"))).toThrow(/Cannot add/);
  });

  it("expands numbers that JavaScript prints in exponent notation", () => {
    // String(1e-7) === "1e-7" and String(1e21) === "1e+21": both must go through string math.
    expect(normalizeDecimal(1e-7, 7)).toBe("0.0000001");
    expect(normalizeDecimal(-2.5e-7, 8)).toBe("-0.00000025");
    expect(() => toMinor(1e-7, "EGP")).toThrow(/more than 2 decimal places/);
    expect(() => toMinor(1e21, "EGP")).toThrow(/too large/);
    expect(() => toMinor(Number.NaN, "EGP")).toThrow(/not a valid EGP amount/);
  });
});
