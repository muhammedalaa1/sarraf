import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function hmacHex(algorithm: "sha256" | "sha512", key: string, data: string): string {
  return createHmac(algorithm, key).update(data, "utf8").digest("hex");
}

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** Constant-time comparison of two hex digests. Case-insensitive; false on length mismatch or bad input. */
export function safeEqualHex(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x.length === 0 || x.length !== y.length || !/^[0-9a-f]+$/.test(x) || !/^[0-9a-f]+$/.test(y))
    return false;
  return timingSafeEqual(Buffer.from(x, "hex"), Buffer.from(y, "hex"));
}
