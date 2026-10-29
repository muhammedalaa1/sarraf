/**
 * Record real sandbox exchanges as scrubbed fixtures (fixtures/<provider>/sandbox-*.json).
 *
 *   pnpm record-fixtures checkout <paymob|kashier|fawry> [--method <m>] [--capture manual]
 *                                                              create a real checkout, save request/response
 *                                                              (paymob: --method cash_outlet for kiosk,
 *                                                              --capture manual to authorize only)
 *   pnpm record-fixtures status <provider> <reference|id>      save a status / transaction inquiry response
 *   pnpm record-fixtures refund <provider> <paymentId> [amount] [--reference <ref>]
 *                                                              refund a paid sandbox payment (amount in
 *                                                              major units, e.g. 3.00; omit for a full refund)
 *   pnpm record-fixtures cancel <provider> <reference>         void a paid sandbox payment (same day)
 *   pnpm record-fixtures capture paymob <transactionId> [amount]
 *                                                              capture an authorization (manual capture)
 *   pnpm record-fixtures charge paymob <cardToken>             charge a saved card on the MOTO integration
 *   pnpm record-fixtures link paymob                           create a payment link (QuickLink)
 *   pnpm record-fixtures webhook [--port 4545]                 capture webhooks at /webhooks/:provider
 *                                                              and customer redirects at /return/:provider
 *
 * Webhooks and redirects are verified with your REAL secret first (that is what proves a signature recipe ✅),
 * then scrubbed and re-signed with a throwaway test secret so the fixture can be committed.
 * Reads credentials from .env.sandbox. Sandbox keys only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import {
  asRecord,
  type FetchLike,
  isSarrafError,
  type PaymentMethod,
  type ProviderId,
  type RawWebhookRequest,
  toMinor,
} from "@sarrafjs/core";
import { fawryNotificationSignature } from "@sarrafjs/fawry";
import { signFawryNotification } from "@sarrafjs/fawry/testing";
import { kashierRedirectSignedString, kashierWebhookSignedString } from "@sarrafjs/kashier";
import { signKashierRedirect, signKashierWebhook } from "@sarrafjs/kashier/testing";
import {
  paymobSignedString,
  paymobSubscriptionSignedString,
  paymobTokenSignedString,
} from "@sarrafjs/paymob";
import {
  signPaymobCallback,
  signPaymobRedirect,
  signPaymobSubscriptionCallback,
  signPaymobTokenCallback,
} from "@sarrafjs/paymob/testing";
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
      if (init.body instanceof FormData) requestBody = Object.fromEntries(init.body.entries());
      else if (typeof init.body === "string") requestBody = JSON.parse(init.body);
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

async function recordCheckout(
  provider: ProviderId,
  flags: { method?: PaymentMethod | undefined; capture?: "manual" | undefined } = {},
) {
  const log: Exchange[] = [];
  const pay = sandboxSarraf({ http: { fetch: recordingFetch(log) }, debug: true });
  const reference = `sarraf_fx_${Date.now()}`;
  const publicUrl = env("SANDBOX_PUBLIC_URL");
  const checkout = await pay.checkout.create({
    provider,
    reference,
    ...SAMPLE,
    methods: flags.method ? [flags.method] : undefined,
    providerOptions: provider === "paymob" && flags.capture ? { capture: flags.capture } : undefined,
    returnUrl: publicUrl ? `${publicUrl}/return/${provider}` : "https://example.com/return",
    webhookUrl: publicUrl ? `${publicUrl}/webhooks/${provider}` : undefined,
  });
  const variant = flags.method ? `-${flags.method}` : flags.capture ? "-auth" : "";
  save(provider, `sandbox-checkout${variant}`, {
    description: `Real ${provider} sandbox checkout (scrubbed).`,
    exchanges: scrubExchanges(log),
    data: { kind: checkout.kind, status: checkout.payment.status, reference },
  });
  console.log(`\n  reference: ${reference}`);
  if (checkout.redirectUrl) console.log(`  pay here:  ${checkout.redirectUrl}`);
  if (checkout.referenceCode) console.log(`  reference code: ${checkout.referenceCode}`);
}

/** Run a Paymob-only call and save its exchanges, also when Paymob rejects it. */
async function recordPaymob(
  scenario: string,
  description: string,
  run: (pay: ReturnType<typeof sandboxSarraf>) => Promise<unknown>,
) {
  const log: Exchange[] = [];
  const pay = sandboxSarraf({ http: { fetch: recordingFetch(log) } });
  let outcome: string;
  let data: unknown;
  try {
    data = await run(pay);
    outcome = String(
      (data as { status?: string; state?: string }).status ?? (data as { state?: string }).state ?? "ok",
    );
    console.log(`  ${scenario} → ${outcome}`);
  } catch (err) {
    outcome = "error";
    data = isSarrafError(err)
      ? { code: err.code, message: err.message, status: err.status }
      : { error: String(err) };
    console.log(`  ${scenario} rejected: ${String(err)}`);
  }
  save("paymob", `sandbox-${scenario}-${outcome}`, {
    description: `Real Paymob sandbox ${description} (scrubbed).`,
    exchanges: scrubExchanges(log).filter((e) => !/auth\/tokens/.test(e.url)),
    data: scrub(data),
  });
}

async function recordCapture(transactionId: string, major?: string) {
  const currency = SAMPLE.amount.currency;
  const amount = major ? { value: toMinor(major, currency), currency } : undefined;
  await recordPaymob(`capture-${major ? "partial" : "full"}`, "capture", async (pay) =>
    pay.payments.capture({ provider: "paymob", providerPaymentId: transactionId, amount }),
  );
}

async function recordCharge(token: string) {
  await recordPaymob("charge-saved-card", "MOTO charge on a saved card", async (pay) =>
    pay.provider("paymob").extras.cards.charge({ token, reference: `sarraf_fx_${Date.now()}`, ...SAMPLE }),
  );
}

async function recordLink() {
  const publicUrl = env("SANDBOX_PUBLIC_URL");
  await recordPaymob("link", "payment link", async (pay) => {
    const link = await pay.provider("paymob").extras.links.create({
      amount: SAMPLE.amount,
      reference: `sarraf_fx_${Date.now()}`,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      notificationUrl: publicUrl ? `${publicUrl}/webhooks/paymob` : undefined,
    });
    console.log(`  pay here: ${link.url}`);
    return link;
  });
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

/**
 * Refund a paid sandbox payment and save the exchange, also when the provider rejects it: the
 * error response is what shows how a beta refund call has to change.
 */
async function recordRefund(
  provider: ProviderId,
  providerPaymentId: string,
  major?: string,
  reference?: string,
) {
  const log: Exchange[] = [];
  const pay = sandboxSarraf({ http: { fetch: recordingFetch(log) } });
  const currency = SAMPLE.amount.currency;
  const amount = major ? { value: toMinor(major, currency), currency } : undefined;
  let outcome: string;
  let data: Record<string, unknown>;
  try {
    const refund = await pay.refunds.create({ provider, providerPaymentId, amount, reference });
    outcome = refund.status;
    data = { status: refund.status, amount: refund.amount, providerRefundId: refund.providerRefundId };
    console.log(`  refund ${refund.status}: ${JSON.stringify(refund.amount ?? "full")}`);
  } catch (err) {
    outcome = "error";
    data = isSarrafError(err)
      ? { code: err.code, message: err.message, status: err.status }
      : { error: String(err) };
    console.log(`  refund rejected: ${String(err)}`);
  }
  save(provider, `sandbox-refund-${major ? "partial" : "full"}-${outcome}`, {
    description: `Real ${provider} sandbox refund call (scrubbed).`,
    exchanges: scrubExchanges(log).filter((e) => !/auth\/tokens/.test(e.url)),
    data,
  });
}

/** Void / cancel a sandbox payment and save the exchanges, also when the provider rejects it. */
async function recordCancel(provider: ProviderId, reference: string) {
  const log: Exchange[] = [];
  const pay = sandboxSarraf({ http: { fetch: recordingFetch(log) } });
  let outcome: string;
  let data: Record<string, unknown>;
  try {
    const payment = await pay.payments.cancel({ provider, reference });
    outcome = payment.status;
    data = { status: payment.status, amount: payment.amount, amountRefunded: payment.amountRefunded };
    console.log(`  cancel → payment ${payment.status}`);
  } catch (err) {
    outcome = "error";
    data = isSarrafError(err)
      ? { code: err.code, message: err.message, status: err.status }
      : { error: String(err) };
    console.log(`  cancel rejected: ${String(err)}`);
  }
  save(provider, `sandbox-cancel-${outcome}`, {
    description: `Real ${provider} sandbox void / cancel call (scrubbed).`,
    exchanges: scrubExchanges(log).filter((e) => !/auth\/tokens/.test(e.url)),
    data,
  });
}

/** Scrub a captured webhook and re-sign it with the throwaway test secret. */
export function resign(provider: ProviderId, req: RawWebhookRequest) {
  const body = JSON.parse(
    typeof req.rawBody === "string" ? req.rawBody : new TextDecoder().decode(req.rawBody),
  );
  const secret = TEST_SECRETS[provider];
  if (provider === "paymob" && body.trigger_type) {
    const { hmac: _drop, ...rest } = scrub(asRecord(body));
    const signed = signPaymobSubscriptionCallback(rest, secret);
    const expected = asRecord(JSON.parse(signed.rawBody as string)).hmac;
    return {
      webhook: signed,
      signedString: paymobSubscriptionSignedString(rest),
      expectedSignature: expected,
    };
  }
  if (provider === "paymob" && body.type === "TOKEN") {
    const obj = scrub(asRecord(body.obj));
    const signed = signPaymobTokenCallback(obj, secret);
    return {
      webhook: signed,
      signedString: paymobTokenSignedString(obj),
      expectedSignature: signed.query!.hmac,
    };
  }
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

/**
 * Scrub captured redirect params and re-sign them with the throwaway test secret. The provider's
 * signature field is dropped first; the remaining params keep the order they arrived in, which
 * Kashier's redirect signature depends on. Fawry does not sign redirects.
 */
export function resignRedirect(provider: ProviderId, query: Record<string, string>) {
  const secret = TEST_SECRETS[provider];
  if (provider === "kashier") {
    const { signature: _drop, ...rest } = query;
    const params = scrub(rest);
    const signed = signKashierRedirect(params, secret);
    return {
      query: signed,
      signedString: kashierRedirectSignedString(params),
      expectedSignature: signed.signature,
    };
  }
  if (provider === "paymob") {
    const { hmac: _drop, ...rest } = query;
    const signed = signPaymobRedirect(scrub(rest), secret);
    return { query: signed, expectedSignature: signed.hmac };
  }
  return { query: scrub(query) };
}

async function recordRedirect(pay: ReturnType<typeof sandboxSarraf>, provider: ProviderId, url: URL) {
  const query = Object.fromEntries(url.searchParams);
  console.log(`
← ${provider} redirect: ${[...url.searchParams.keys()].join(", ")}`);
  if (provider === "kashier")
    console.log(`  signed string: ${kashierRedirectSignedString([...url.searchParams])}`);
  let result: Awaited<ReturnType<typeof pay.redirects.verify>> | undefined;
  try {
    result = await pay.redirects.verify(provider, query);
    console.log(
      `  signature: ${result.authenticated ? "✓ VALID" : "✗ INVALID"} · status ${result.status} · reference ${result.reference ?? "?"}`,
    );
  } catch (err) {
    console.log(`  not verified: ${String(err)}`);
  }
  save(provider, `sandbox-redirect-${result?.status ?? "unverified"}`, {
    description: `Real ${provider} customer redirect, scrubbed and re-signed with the test secret.`,
    verifiedAgainstRealSignature: result?.authenticated ?? false,
    secret: TEST_SECRETS[provider],
    ...resignRedirect(provider, query),
  });
}

async function captureWebhooks(port: number) {
  const pay = sandboxSarraf();
  const counts: Record<string, number> = {};
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const ret = /^\/return\/(paymob|kashier|fawry)$/.exec(url.pathname);
    if (req.method === "GET" && ret) {
      res
        .writeHead(200, { "content-type": "text/plain" })
        .end("Sarraf sandbox: payment returned. Check the terminal.");
      if (url.searchParams.size > 0) {
        recordRedirect(pay, ret[1] as ProviderId, url).catch((err: unknown) => {
          console.error(`  failed to record redirect: ${String(err)}`);
        });
      }
      return;
    }
    const m = /^\/webhooks\/(paymob|kashier|fawry)$/.exec(url.pathname);
    if (req.method !== "POST" || !m) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
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
        const subscription = provider === "paymob" && /"trigger_type"/.test(String(raw.rawBody));
        const inspection = subscription
          ? pay.provider("paymob").extras.subscriptions.inspectWebhook(raw)
          : await pay.webhooks.inspect(provider, raw);
        console.log(
          `\n← ${provider} webhook: signature ${inspection.valid ? "✓ VALID" : `✗ INVALID (${inspection.reason ?? "mismatch"})`}`,
        );
        console.log(`  signed string: ${inspection.signedString}`);
        let status = "unverified";
        if (inspection.valid && subscription) {
          const event = pay.provider("paymob").extras.subscriptions.verifyWebhook(raw);
          status = `subscription-${event.trigger.toLowerCase().replace(/\W+/g, "-")}`;
          console.log(`  subscription event: ${event.trigger} (${event.id})`);
        } else if (inspection.valid) {
          const event = await pay.webhooks.verifyAndParse(provider, raw);
          status = event.type === "card.saved" ? "card-saved" : event.payment.status;
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
    console.log(`Listening on http://localhost:${port}/webhooks/:provider and /return/:provider`);
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
  const flag = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  if (cmd === "checkout" && a) {
    return recordCheckout(a as ProviderId, {
      method: flag("method") as PaymentMethod | undefined,
      capture: flag("capture") === "manual" ? "manual" : undefined,
    });
  }
  if (cmd === "capture" && a === "paymob" && b) return recordCapture(b, process.argv[5]);
  if (cmd === "charge" && a === "paymob" && b) return recordCharge(b);
  if (cmd === "link" && a === "paymob") return recordLink();
  if (cmd === "status" && a && b) return recordStatus(a as ProviderId, b);
  if (cmd === "cancel" && a && b) return recordCancel(a as ProviderId, b);
  if (cmd === "refund" && a && b) {
    const refIdx = process.argv.indexOf("--reference");
    const reference = refIdx > 0 ? process.argv[refIdx + 1] : undefined;
    const major = process.argv[5]?.startsWith("--") ? undefined : process.argv[5];
    return recordRefund(a as ProviderId, b, major, reference);
  }
  if (cmd === "webhook") {
    const portIdx = process.argv.indexOf("--port");
    return captureWebhooks(portIdx > 0 ? Number(process.argv[portIdx + 1]) : 4545);
  }
  console.log(
    "Usage:\n  record-fixtures checkout <provider> [--method <m>] [--capture manual]\n  record-fixtures capture paymob <transactionId> [amount]\n  record-fixtures charge paymob <cardToken>\n  record-fixtures link paymob\n  record-fixtures status <provider> <reference|id>\n  record-fixtures refund <provider> <paymentId> [amount] [--reference <ref>]\n  record-fixtures cancel <provider> <reference>\n  record-fixtures webhook [--port 4545]",
  );
  process.exit(1);
}

if (process.argv[1] && /record-fixtures\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
}
