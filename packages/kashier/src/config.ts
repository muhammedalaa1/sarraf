import { type Currency, SarrafError } from "@sarrafjs/core";
import { z } from "zod";

/** ⚠️ Base URLs: confirm against the Kashier dashboard / docs for your account. Override with `urls`. */
export const KASHIER_URLS = {
  test: {
    checkout: "https://checkout.kashier.io",
    api: "https://test-api.kashier.io",
    fep: "https://test-fep.kashier.io",
  },
  live: {
    checkout: "https://checkout.kashier.io",
    api: "https://api.kashier.io",
    fep: "https://fep.kashier.io",
  },
} as const;

export const kashierOptionsSchema = z.object({
  /** Merchant id, e.g. `MID-123-456`. */
  merchantId: z.string().min(1, "merchantId is required"),
  /** Payment API key: signs the hosted-page hash and verifies redirect / webhook signatures. */
  apiKey: z.string().min(1, "apiKey is required"),
  /** Secret key: server API calls (refunds, order lookup, sessions). */
  secretKey: z.string().min(1).optional(),
  mode: z.enum(["test", "live"]).default("test"),
  /**
   * How the major-unit amount string is written in the hash and URL. Both always use the same
   * string. "fixed" → "250.00", "trimmed" → "250" (Kashier's demo style).
   */
  amountFormat: z.enum(["fixed", "trimmed"]).default("fixed"),
  currencies: z.array(z.string()).optional(),
  urls: z
    .object({
      checkout: z.string().url().optional(),
      api: z.string().url().optional(),
      fep: z.string().url().optional(),
    })
    .optional(),
});

export type KashierOptions = z.input<typeof kashierOptionsSchema>;

export interface KashierConfig {
  merchantId: string;
  apiKey: string;
  secretKey?: string | undefined;
  mode: "test" | "live";
  amountFormat: "fixed" | "trimmed";
  currencies: Currency[];
  urls: { checkout: string; api: string; fep: string };
}

export function resolveConfig(options: KashierOptions): KashierConfig {
  const parsed = kashierOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new SarrafError(
      "CONFIGURATION_INVALID",
      `kashier(): ${parsed.error.issues.map((i) => `${i.path.join(".") || "options"} ${i.message}`).join("; ")}`,
      { provider: "kashier" },
    );
  }
  const o = parsed.data;
  const defaults = KASHIER_URLS[o.mode];
  const strip = (u: string) => u.replace(/\/+$/, "");
  return {
    merchantId: o.merchantId,
    apiKey: o.apiKey,
    secretKey: o.secretKey,
    mode: o.mode,
    amountFormat: o.amountFormat,
    currencies: (o.currencies as Currency[] | undefined) ?? ["EGP", "USD"],
    urls: {
      checkout: strip(o.urls?.checkout ?? defaults.checkout),
      api: strip(o.urls?.api ?? defaults.api),
      fep: strip(o.urls?.fep ?? defaults.fep),
    },
  };
}
