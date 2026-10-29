import { type Currency, SarrafError } from "@sarrafjs/core";
import { z } from "zod";

export const PAYMOB_REGIONS = {
  egypt: { baseUrl: "https://accept.paymob.com", currency: "EGP" },
  ksa: { baseUrl: "https://ksa.paymob.com", currency: "SAR" },
  uae: { baseUrl: "https://uae.paymob.com", currency: "AED" },
  oman: { baseUrl: "https://oman.paymob.com", currency: "OMR" },
} as const satisfies Record<string, { baseUrl: string; currency: Currency }>;

export type PaymobRegion = keyof typeof PAYMOB_REGIONS;

const methods = ["card", "wallet", "cash_outlet", "installments", "bnpl", "bank_transfer", "other"] as const;

/**
 * Integration ids beyond one-per-method:
 * - `card_auth`: card integration in Auth mode, for `providerOptions.capture: "manual"`.
 * - `card_moto`: MOTO integration, for merchant-initiated charges on saved cards and subscriptions.
 * - `apple_pay`: offered next to `card` on the Unified Checkout.
 */
const integrations = [...methods, "card_auth", "card_moto", "apple_pay"] as const;

export type PaymobIntegration = (typeof integrations)[number];

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
  /**
   * Integration ids, one per payment method (`card`, `wallet`, `cash_outlet` for kiosk, `bnpl`,
   * `installments`, …) plus `card_auth`, `card_moto` and `apple_pay`. Test/live mode must match the keys.
   */
  integrationIds: z
    .partialRecord(z.enum(integrations), z.number().int().positive())
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
  integrationIds: Partial<Record<PaymobIntegration, number>>;
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

/** Env var suffixes for each integration: `PAYMOB_<NAME>_INTEGRATION_ID`. */
export const PAYMOB_INTEGRATION_ENV: Record<PaymobIntegration, string> = {
  card: "CARD",
  wallet: "WALLET",
  cash_outlet: "KIOSK",
  installments: "INSTALLMENTS",
  bnpl: "BNPL",
  bank_transfer: "BANK_TRANSFER",
  other: "OTHER",
  card_auth: "CARD_AUTH",
  card_moto: "CARD_MOTO",
  apple_pay: "APPLE_PAY",
};

/**
 * Read `PAYMOB_CARD_INTEGRATION_ID`, `PAYMOB_WALLET_INTEGRATION_ID`, `PAYMOB_KIOSK_INTEGRATION_ID`,
 * `PAYMOB_CARD_AUTH_INTEGRATION_ID`, `PAYMOB_CARD_MOTO_INTEGRATION_ID`, … into `integrationIds`.
 */
export function paymobIntegrationIdsFromEnv(
  env: Record<string, string | undefined>,
): Partial<Record<PaymobIntegration, number>> {
  const ids: Partial<Record<PaymobIntegration, number>> = {};
  for (const [key, name] of Object.entries(PAYMOB_INTEGRATION_ENV) as [PaymobIntegration, string][]) {
    const value = env[`PAYMOB_${name}_INTEGRATION_ID`]?.trim();
    if (value) ids[key] = Number(value);
  }
  return ids;
}
