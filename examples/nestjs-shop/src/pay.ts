import { Sarraf, type SarrafOptions } from "@sarrafjs/core";
import { fawry } from "@sarrafjs/fawry";
import { kashier } from "@sarrafjs/kashier";
import { paymob } from "@sarrafjs/paymob";
import { fakeProvider } from "@sarrafjs/testing";

const env = (k: string) => process.env[k] || undefined;

/**
 * Real adapters when credentials are present, otherwise in-memory fakes ("demo mode") so the
 * example runs without any account.
 */
export function createPay(options: { demo?: boolean } = {}) {
  const demo =
    options.demo ?? !(env("PAYMOB_SECRET_KEY") || env("KASHIER_API_KEY") || env("FAWRY_SECURE_KEY"));
  const providers: SarrafOptions["providers"] = {};
  if (demo) {
    providers.paymob = fakeProvider("paymob");
    providers.kashier = fakeProvider("kashier");
    providers.fawry = fakeProvider("fawry", { checkoutKind: "reference_code" });
  } else {
    if (env("PAYMOB_SECRET_KEY")) {
      providers.paymob = paymob({
        secretKey: env("PAYMOB_SECRET_KEY")!,
        publicKey: env("PAYMOB_PUBLIC_KEY")!,
        hmacSecret: env("PAYMOB_HMAC_SECRET")!,
        apiKey: env("PAYMOB_API_KEY"),
        integrationIds: { card: Number(env("PAYMOB_CARD_INTEGRATION_ID")) },
      });
    }
    if (env("KASHIER_API_KEY")) {
      providers.kashier = kashier({
        merchantId: env("KASHIER_MERCHANT_ID")!,
        apiKey: env("KASHIER_API_KEY")!,
        secretKey: env("KASHIER_SECRET_KEY"),
        mode: "test",
      });
    }
    if (env("FAWRY_SECURE_KEY")) {
      providers.fawry = fawry({
        merchantCode: env("FAWRY_MERCHANT_CODE")!,
        secureKey: env("FAWRY_SECURE_KEY")!,
        environment: "staging",
      });
    }
  }
  return { pay: new Sarraf({ providers, debug: env("SARRAF_DEBUG") === "1" }), demo };
}
