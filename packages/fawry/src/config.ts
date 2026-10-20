import { SarrafError } from "@sarraf/core";
import { z } from "zod";

/** ⚠️ Base URLs: confirm with Fawry for your account. Override with `baseUrl`. */
export const FAWRY_BASE_URLS = {
  staging: "https://atfawry.fawrystaging.com",
  production: "https://www.atfawry.com",
} as const;

export const fawryOptionsSchema = z.object({
  merchantCode: z.string().min(1, "merchantCode is required"),
  /** Secret appended to every signature (plain SHA-256, not HMAC). */
  secureKey: z.string().min(1, "secureKey is required"),
  environment: z.enum(["staging", "production"]).default("staging"),
  baseUrl: z.string().url().optional(),
  /**
   * After a valid notification signature, re-query the payment status before trusting it.
   * Default true until the V2 signature recipe is verified against real notifications.
   */
  confirmWithStatusQuery: z.boolean().default(true),
  /** Language for APIs that take one. */
  language: z.enum(["en-gb", "ar-eg"]).default("en-gb"),
});

export type FawryOptions = z.input<typeof fawryOptionsSchema>;

export interface FawryConfig {
  merchantCode: string;
  secureKey: string;
  environment: "staging" | "production";
  baseUrl: string;
  confirmWithStatusQuery: boolean;
  language: "en-gb" | "ar-eg";
}

export function resolveConfig(options: FawryOptions): FawryConfig {
  const parsed = fawryOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new SarrafError(
      "CONFIGURATION_INVALID",
      `fawry(): ${parsed.error.issues.map((i) => `${i.path.join(".") || "options"} ${i.message}`).join("; ")}`,
      { provider: "fawry" },
    );
  }
  const o = parsed.data;
  return {
    merchantCode: o.merchantCode,
    secureKey: o.secureKey,
    environment: o.environment,
    baseUrl: (o.baseUrl ?? FAWRY_BASE_URLS[o.environment]).replace(/\/+$/, ""),
    confirmWithStatusQuery: o.confirmWithStatusQuery,
    language: o.language,
  };
}
