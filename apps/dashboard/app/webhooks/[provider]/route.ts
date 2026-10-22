import type { ProviderId } from "@sarrafjs/core";
import { inbox } from "../../../lib/inbox";
import { clientKey, limits, tooMany } from "../../../lib/rate-limit";
import { getSarraf } from "../../../lib/sarraf";
import { captureWebhook } from "../../../lib/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Point your sandbox callback URL at <dashboard>/webhooks/<provider>. */
export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  if (!limits.webhook.take(clientKey(req))) return tooMany();
  const { provider } = await params;
  const { pay } = getSarraf();
  if (!pay.providerIds.includes(provider as ProviderId)) {
    return Response.json({ error: "UNKNOWN_PROVIDER" }, { status: 404 });
  }
  const rawBody = await req.text();
  if (rawBody.length > 256_000) return Response.json({ error: "PAYLOAD_TOO_LARGE" }, { status: 413 });
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const entry = await captureWebhook(pay, inbox, provider as ProviderId, {
    headers,
    query: Object.fromEntries(new URL(req.url).searchParams),
    rawBody,
  });
  // Always 200 so providers don't retry forever while you debug; the inbox shows the result.
  return Response.json({ received: true, id: entry.id, valid: entry.inspection.valid });
}
