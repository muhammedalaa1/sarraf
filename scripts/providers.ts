import { Sarraf, type SarrafOptions } from "@sarraf/core";
import { type FawryProvider, fawry } from "@sarraf/fawry";
import { type KashierProvider, kashier } from "@sarraf/kashier";
import { type PaymobProvider, paymob, paymobIntegrationIdsFromEnv } from "@sarraf/paymob";
import { assertSandbox, env, hasFawry, hasKashier, hasPaymob } from "./env.js";

/** Build sandbox adapters from process.env (see .env.sandbox.example). */
export interface SandboxProviders {
  paymob?: PaymobProvider;
  kashier?: KashierProvider;
  fawry?: FawryProvider;
}

export function sandboxProviders(): SandboxProviders {
  const providers: SandboxProviders = {};
  for (const name of Object.keys(process.env).filter((k) => /^(PAYMOB|KASHIER|FAWRY)_/.test(k))) {
    assertSandbox(name, env(name));
  }
  if (hasPaymob()) {
    const integrationIds = paymobIntegrationIdsFromEnv(process.env);
    providers.paymob = paymob({
      region: (env("PAYMOB_REGION") as "egypt") ?? "egypt",
      secretKey: env("PAYMOB_SECRET_KEY")!,
      publicKey: env("PAYMOB_PUBLIC_KEY")!,
      hmacSecret: env("PAYMOB_HMAC_SECRET")!,
      apiKey: env("PAYMOB_API_KEY"),
      integrationIds,
    });
  }
  if (hasKashier()) {
    providers.kashier = kashier({
      merchantId: env("KASHIER_MERCHANT_ID")!,
      apiKey: env("KASHIER_API_KEY")!,
      secretKey: env("KASHIER_SECRET_KEY"),
      mode: "test",
    });
  }
  if (hasFawry()) {
    providers.fawry = fawry({
      merchantCode: env("FAWRY_MERCHANT_CODE")!,
      secureKey: env("FAWRY_SECURE_KEY")!,
      environment: "staging",
    });
  }
  return providers;
}

export function sandboxSarraf(
  extra: Partial<Omit<SarrafOptions, "providers">> = {},
): Sarraf<SandboxProviders> {
  return new Sarraf({ providers: sandboxProviders(), allowBeta: true, ...extra });
}
