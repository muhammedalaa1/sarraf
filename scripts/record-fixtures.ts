/**
 * Record real sandbox exchanges as scrubbed fixtures (fixtures/<provider>/sandbox-*.json).
 *
 *   pnpm record-fixtures checkout <paymob|kashier|fawry>      create a real checkout, save request/response
 *   pnpm record-fixtures status <provider> <reference|id>      save a status / transaction inquiry response
 *   pnpm record-fixtures webhook [--port 4545]                 capture webhooks at /webhooks/:provider
 *
 * Webhooks are verified with your REAL secret first (that is what proves a signature recipe ✅),
 * then scrubbed and re-signed with a throwaway test secret so the fixture can be committed.
 * Reads credentials from .env.sandbox. Sandbox keys only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { asRecord, type FetchLike, type ProviderId, type RawWebhookRequest } from "@sarraf/core";
import { fawryNotificationSignature } from "@sarraf/fawry";
import { signFawryNotification } from "@sarraf/fawry/testing";
import { kashierWebhookSignedString } from "@sarraf/kashier";
import { signKashierWebhook } from "@sarraf/kashier/testing";
import { paymobSignedString } from "@sarraf/paymob";
import { signPaymobCallback } from "@sarraf/paymob/testing";
import { env, loadSandboxEnv, ROOT } from "./env.js";
import { sandboxSarraf } from "./providers.js";
import { scrub, scrubUrl } from "./scrub.js";

export const TEST_SECRETS: Record<ProviderId, string> = {
  paymob: "test_hmac_secret_do_not_use",
  kashier: "test_payment_api_key_do_not_use",
  fawry: "test_secure_key_do_not_use",
};

interface Exchange {
  method: string;
  url: string;
  requestBody?: unknown | undefined;
  status: number;
  responseBody: unknown;
}

function recordingFetch(log: Exchange[]): FetchLike {
  return async (url, init) => {
    const res = await fetch(url, init);
    const text = await res.clone().text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON: keep the raw value
    }
    let requestBody: unknown = init.body;
    try {
      requestBody = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    } catch {
      // not JSON: keep the raw value
    }
    log.push({ method: init.method ?? "GET", url, requestBody, status: res.status, responseBody: body });
    return res;
  };
}

function save(provider: string, scenario: string, data: Record<string, unknown>) {
  const dir = join(ROOT, "fixtures", provider);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${scenario}.json`);
  writeFileSync(
    file,
    `${JSON.stringify({ provider, scenario, source: "sandbox", recordedAt: new Date().toISOString(), ...data }, null, 2)}\n`,
  );
  console.log(`  saved ${file}`);
}

function scrubExchanges(log: Exchange[]) {
  return log.map((e) => ({
    ...e,
    url: scrubUrl(e.url),
    requestBody: scrub(e.requestBody),
    responseBody: scrub(e.responseBody),
  }));
}

const SAMPLE = {
  amount: { value: 1000, currency: "EGP" as const },
  customer: { name: "Sandbox Tester", email: "tester@example.com", phone: "+201000000000" },
};

async function recordCheckout(provider: ProviderId) {
  const log: Exchange[] = [];
  const pay = sandboxSarraf({ http: { fetch: recordingFetch(log) }, debug: true });
  const reference = `sarraf_fx_${Date.now()}`;
  const publicUrl = env("SANDBOX_PUBLIC_URL");
  const checkout = await pay.checkout.create({
    provider,
    reference,
    ...SAMPLE,
    returnUrl: publicUrl ? `${publicUrl}/return/${provider}` : "https://example.com/return",
    webhookUrl: publicUrl ? `${publicUrl}/webhooks/${provider}` : undefined,
  });
  save(provider, "sandbox-checkout", {
    description: `Real ${provider} sandbox checkout (scrubbed).`,
    exchanges: scrubExchanges(log),
    data: { kind: checkout.kind, status: checkout.payment.status, reference },
  });
  console.log(`\n  reference: ${reference}`);
  if (checkout.redirectUrl) console.log(`  pay here:  ${checkout.redirectUrl}`);
  if (checkout.referenceCode) console.log(`  Fawry reference code: ${checkout.referenceCode}`);
}

async function recordStatus(provider: ProviderId, idOrRef: string) {
  const log: Exchange[] = [];
  const pay = sandboxSarraf({ http: { fetch: recordingFetch(log) } });
  const byId = provider === "paymob" && /^\d+$/.test(idOrRef);
  const payment = await pay.payments.get(
    byId ? { provider, providerPaymentId: idOrRef } : { provider, reference: idOrRef },
  );
  save(provider, `sandbox-status-${payment.status}`, {
    description: `Real ${provider} status response for a ${payment.status} payment (scrubbed).`,
    exchanges: scrubExchanges(log).filter((e) => !/auth\/tokens/.test(e.url)),
    data: { status: payment.status },
  });
}

/** Scrub a captured webhook and re-sign it with the throwaway test secret. */
export function resign(provider: ProviderId, req: RawWebhookRequest) {
  const body = JSON.parse(
    typeof req.rawBody === "string" ? req.rawBody : new TextDecoder().decode(req.rawBody),
  );
  const secret = TEST_SECRETS[provider];
  if (provider === "paymob") {
    const obj = scrub(asRecord(body.obj));
    const signed = signPaymobCallback(obj as never, secret);
    return { webhook: signed, signedString: paymobSignedString(obj), expectedSignature: signed.query!.hmac };
  }
  if (provider === "kashier") {
    const data = scrub(asRecord(body.data));
    const signed = signKashierWebhook(String(body.event ?? "pay"), data as never, secret);
    return {
      webhook: signed,
      signedString: kashierWebhookSignedString(data),
      expectedSignature: (signed.headers as Record<string, string>)["x-kashier-signature"],
    };
  }
  const { messageSignature: _drop, ...n } = scrub(asRecord(body), { keep: [] });
  const signed = signFawryNotification(n, secret);
  const parts = fawryNotificationSignature(n, secret);
  return { webhook: signed, signedString: parts.signedString, expectedSignature: parts.signature };
}

async function captureWebhooks(port: number) {
  const pay = sandboxSarraf();
  const counts: Record<string, number> = {};
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const m = /^\/webhooks\/(paymob|kashier|fawry)$/.exec(url.pathname);
    if (req.method !== "POST" || !m) {
      res.writeHead(url.pathname.startsWith("/return/") ? 200 : 404, { "content-type": "text/plain" });
      res.end(
        url.pathname.startsWith("/return/")
          ? "Sarraf sandbox: payment returned. Check the terminal."
          : "not found",
      );
      return;
    }
    const provider = m[1] as ProviderId;
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      res.writeHead(200).end("ok");
      const raw: RawWebhookRequest = {
        rawBody: Buffer.concat(chunks),
        headers: req.headers,
        query: Object.fromEntries(url.searchParams),
      };
      try {
        const inspection = await pay.webhooks.inspect(provider, raw);
        console.log(
          `\n← ${provider} webhook: signature ${inspection.valid ? "✓ VALID" : `✗ INVALID (${inspection.reason ?? "mismatch"})`}`,
        );
        console.log(`  signed string: ${inspection.signedString}`);
        let status = "unverified";
        if (inspection.valid) {
          const event = await pay.webhooks.verifyAndParse(provider, raw);
          status = event.payment.status;
          console.log(`  event: ${event.type} (${event.id})`);
        }
        counts[provider] = (counts[provider] ?? 0) + 1;
        save(provider, `sandbox-webhook-${status}-${counts[provider]}`, {
          description: `Real ${provider} webhook, scrubbed and re-signed with the test secret.`,
          verifiedAgainstRealSignature: inspection.valid,
          secret: TEST_SECRETS[provider],
          ...resign(provider, raw),
        });
      } catch (err) {
        console.error(`  failed to record: ${String(err)}`);
      }
    });
  });
  server.listen(port, () => {
    console.log(`Listening on http://localhost:${port}/webhooks/:provider`);
    console.log(`Expose it with:  cloudflared tunnel --url http://localhost:${port}`);
    console.log("Then set SANDBOX_PUBLIC_URL and use <url>/webhooks/<provider> as the callback URL.");
  });
}

async function main() {
  if (!loadSandboxEnv()) {
    console.error("Missing .env.sandbox. Copy .env.sandbox.example and fill in sandbox credentials.");
    process.exit(1);
  }
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === "checkout" && a) return recordCheckout(a as ProviderId);
  if (cmd === "status" && a && b) return recordStatus(a as ProviderId, b);
  if (cmd === "webhook") {
    const portIdx = process.argv.indexOf("--port");
    return captureWebhooks(portIdx > 0 ? Number(process.argv[portIdx + 1]) : 4545);
  }
  console.log(
    "Usage:\n  record-fixtures checkout <provider>\n  record-fixtures status <provider> <reference|id>\n  record-fixtures webhook [--port 4545]",
  );
  process.exit(1);
}

if (process.argv[1] && /record-fixtures\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
}
