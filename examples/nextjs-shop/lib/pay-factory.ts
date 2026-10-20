import { Sarraf, type SarrafOptions } from "@sarraf/core";
import { fawry } from "@sarraf/fawry";
import { kashier } from "@sarraf/kashier";
import { paymob } from "@sarraf/paymob";
import { fakeProvider } from "@sarraf/testing";

const env = (k: string) => process.env[k] || undefined;

/**
 * Real adapters when credentials are present, otherwise in-memory fakes ("demo mode") so the
 * example runs without any account.
 */
export function createPay(options: { demo?: boolean; publicUrl?: string } = {}) {
  const demo =
    options.demo ?? !(env("PAYMOB_SECRET_KEY") || env("KASHIER_API_KEY") || env("FAWRY_SECURE_KEY"));
  const providers: SarrafOptions["providers"] = {};
  if (demo) {
    // Fake redirects land on this shop's own /demo/pay page instead of a real provider.
    const redirectBaseUrl = `${options.publicUrl ?? "http://localhost:3002"}/demo/pay`;
    providers.paymob = fakeProvider("paymob", { redirectBaseUrl });
    providers.kashier = fakeProvider("kashier", { redirectBaseUrl });
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
