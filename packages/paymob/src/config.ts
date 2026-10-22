import { type Currency, type PaymentMethod, SarrafError } from "@sarrafjs/core";
import { z } from "zod";

export const PAYMOB_REGIONS = {
  egypt: { baseUrl: "https://accept.paymob.com", currency: "EGP" },
  ksa: { baseUrl: "https://ksa.paymob.com", currency: "SAR" },
  uae: { baseUrl: "https://uae.paymob.com", currency: "AED" },
  oman: { baseUrl: "https://oman.paymob.com", currency: "OMR" },
} as const satisfies Record<string, { baseUrl: string; currency: Currency }>;

export type PaymobRegion = keyof typeof PAYMOB_REGIONS;

const methods = ["card", "wallet", "cash_outlet", "installments", "bnpl", "bank_transfer", "other"] as const;

export const paymobOptionsSchema = z.object({
  region: z.enum(["egypt", "ksa", "uae", "oman"]).default("egypt"),
  /** Secret key (`sk_test_…` / `sk_live_…`): creates intentions, refunds, voids. */
  secretKey: z.string().min(1, "secretKey is required"),
  /** Public key (`pk_…`): builds the Unified Checkout URL. Safe for browsers. */
  publicKey: z.string().min(1, "publicKey is required"),
  /** HMAC secret from the dashboard: verifies transaction callbacks. */
  hmacSecret: z.string().min(1, "hmacSecret is required"),
  /** Legacy API key: needed for transaction inquiry (getPayment / reconcile). */
  apiKey: z.string().min(1).optional(),
  /** One integration id per payment method. Test/live mode must match the keys. */
  integrationIds: z
    .partialRecord(z.enum(methods), z.number().int().positive())
    .refine((v) => Object.keys(v).length > 0, "at least one integration id is required"),
  /** Override the region base URL (testing / proxies). */
  baseUrl: z.string().url().optional(),
});

export type PaymobOptions = z.input<typeof paymobOptionsSchema>;

export interface PaymobConfig {
  region: PaymobRegion;
  baseUrl: string;
  currency: Currency;
  secretKey: string;
  publicKey: string;
  hmacSecret: string;
  apiKey?: string | undefined;
  integrationIds: Partial<Record<PaymentMethod, number>>;
  mode: "test" | "live";
}

export function resolveConfig(options: PaymobOptions): PaymobConfig {
  const parsed = paymobOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new SarrafError(
      "CONFIGURATION_INVALID",
      `paymob(): ${parsed.error.issues.map((i) => `${i.path.join(".") || "options"} ${i.message}`).join("; ")}`,
      { provider: "paymob" },
    );
  }
  const o = parsed.data;
  const region = PAYMOB_REGIONS[o.region];
  const keyMode = (k: string) => (/_test_/.test(k) ? "test" : /_live_/.test(k) ? "live" : undefined);
  const secretMode = keyMode(o.secretKey);
  const publicMode = keyMode(o.publicKey);
  if (secretMode && publicMode && secretMode !== publicMode) {
    throw new SarrafError(
      "CONFIGURATION_INVALID",
      `paymob(): secretKey is a ${secretMode} key but publicKey is a ${publicMode} key`,
      { provider: "paymob" },
    );
  }
  return {
    region: o.region,
    baseUrl: (o.baseUrl ?? region.baseUrl).replace(/\/+$/, ""),
    currency: region.currency,
    secretKey: o.secretKey,
    publicKey: o.publicKey,
    hmacSecret: o.hmacSecret,
    apiKey: o.apiKey,
    integrationIds: o.integrationIds,
    mode: secretMode ?? "test",
  };
}
