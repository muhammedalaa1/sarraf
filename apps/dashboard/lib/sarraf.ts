import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type HttpEvent, type PaymentProvider, Sarraf, type SarrafOptions } from "@sarraf/core";
import { fawry } from "@sarraf/fawry";
import { kashier } from "@sarraf/kashier";
import { paymob } from "@sarraf/paymob";
import { fakeProvider } from "@sarraf/testing";
import { config } from "dotenv";

/** The dashboard is sandbox-only. Anything that looks like a live credential is refused. */
export function assertNoLiveKeys(envVars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(envVars)) {
    if (!/^(PAYMOB|KASHIER|FAWRY)_/.test(k) || !v) continue;
    if (/_live_|live_/i.test(v))
      throw new Error(`${k} looks like a LIVE key. The dashboard only accepts sandbox credentials.`);
  }
  if (envVars.KASHIER_MODE === "live" || envVars.FAWRY_ENVIRONMENT === "production") {
    throw new Error("The dashboard only runs against sandbox / staging environments.");
  }
}

export function buildProviders(e: Record<string, string | undefined>): {
  providers: SarrafOptions["providers"];
  demo: boolean;
} {
  assertNoLiveKeys(e);
  const providers: SarrafOptions["providers"] = {};
  if (e.PAYMOB_SECRET_KEY && e.PAYMOB_PUBLIC_KEY && e.PAYMOB_HMAC_SECRET) {
    const integrationIds: Record<string, number> = {};
    if (e.PAYMOB_CARD_INTEGRATION_ID) integrationIds.card = Number(e.PAYMOB_CARD_INTEGRATION_ID);
    if (e.PAYMOB_WALLET_INTEGRATION_ID) integrationIds.wallet = Number(e.PAYMOB_WALLET_INTEGRATION_ID);
    providers.paymob = paymob({
      region: (e.PAYMOB_REGION as "egypt" | undefined) ?? "egypt",
      secretKey: e.PAYMOB_SECRET_KEY,
      publicKey: e.PAYMOB_PUBLIC_KEY,
      hmacSecret: e.PAYMOB_HMAC_SECRET,
      apiKey: e.PAYMOB_API_KEY,
      integrationIds,
    });
  }
  if (e.KASHIER_MERCHANT_ID && e.KASHIER_API_KEY) {
    providers.kashier = kashier({
      merchantId: e.KASHIER_MERCHANT_ID,
      apiKey: e.KASHIER_API_KEY,
      secretKey: e.KASHIER_SECRET_KEY,
      mode: "test",
    });
  }
  if (e.FAWRY_MERCHANT_CODE && e.FAWRY_SECURE_KEY) {
    providers.fawry = fawry({
      merchantCode: e.FAWRY_MERCHANT_CODE,
      secureKey: e.FAWRY_SECURE_KEY,
      environment: "staging",
    });
  }
  if (Object.keys(providers).length > 0) return { providers, demo: false };
  return {
    providers: {
      paymob: fakeProvider("paymob"),
      kashier: fakeProvider("kashier"),
      fawry: fakeProvider("fawry", { checkoutKind: "reference_code" }),
    },
    demo: true,
  };
}

interface DashboardSarraf {
  pay: Sarraf;
  demo: boolean;
  /** HTTP events captured by the most recent request, redacted by core. */
  httpLog: HttpEvent[];
  error?: string | undefined;
}

const g = globalThis as unknown as { __dashboard?: DashboardSarraf };

export function getSarraf(): DashboardSarraf {
  if (g.__dashboard) return g.__dashboard;
  const rootEnv = resolve(process.cwd(), "../../.env.sandbox");
  if (existsSync(rootEnv)) config({ path: rootEnv, override: false });
  const httpLog: HttpEvent[] = [];
  try {
    const { providers, demo } = buildProviders(process.env);
    const pay = new Sarraf({
      providers,
      allowBeta: true,
      http: { hooks: { onRequest: (ev) => httpLog.push(ev), onResponse: (ev) => httpLog.push(ev) } },
    });
    g.__dashboard = { pay, demo, httpLog };
  } catch (err) {
    const { providers } = buildProviders({});
    g.__dashboard = {
      pay: new Sarraf({ providers, allowBeta: true }),
      demo: true,
      httpLog,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return g.__dashboard;
}

export function providerOf(pay: Sarraf, id: string): PaymentProvider | undefined {
  return pay.providerIds.includes(id as never) ? pay.provider(id as never) : undefined;
}
