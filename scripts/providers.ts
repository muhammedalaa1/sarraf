import { Sarraf, type SarrafOptions } from "@sarrafjs/core";
import { fawry } from "@sarrafjs/fawry";
import { kashier } from "@sarrafjs/kashier";
import { paymob } from "@sarrafjs/paymob";
import { assertSandbox, env, hasFawry, hasKashier, hasPaymob } from "./env.js";

/** Build sandbox adapters from process.env (see .env.sandbox.example). */
export function sandboxProviders() {
  const providers: SarrafOptions["providers"] = {};
  for (const name of Object.keys(process.env).filter((k) => /^(PAYMOB|KASHIER|FAWRY)_/.test(k))) {
    assertSandbox(name, env(name));
  }
  if (hasPaymob()) {
    const integrationIds: Record<string, number> = {};
    if (env("PAYMOB_CARD_INTEGRATION_ID")) integrationIds.card = Number(env("PAYMOB_CARD_INTEGRATION_ID"));
    if (env("PAYMOB_WALLET_INTEGRATION_ID"))
      integrationIds.wallet = Number(env("PAYMOB_WALLET_INTEGRATION_ID"));
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

export function sandboxSarraf(extra: Partial<SarrafOptions> = {}) {
  return new Sarraf({ providers: sandboxProviders(), allowBeta: true, ...extra });
}
