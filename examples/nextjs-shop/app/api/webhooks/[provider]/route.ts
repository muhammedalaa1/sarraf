import { isSarrafError, type ProviderId } from "@sarraf/core";
import { applyEvent, getPay } from "../../../../lib/pay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const { pay } = getPay();
  if (!pay.providerIds.includes(provider as ProviderId)) {
    return Response.json({ error: "UNKNOWN_PROVIDER" }, { status: 404 });
  }
  // req.text() returns the exact body; never re-serialize parsed JSON before verifying.
  const rawBody = await req.text();
  const url = new URL(req.url);
  try {
    const event = await pay.webhooks.verifyAndParse(provider as ProviderId, {
      headers: req.headers,
      rawBody,
      query: Object.fromEntries(url.searchParams),
    });
    applyEvent(event); // deduplicated on event.id
    return Response.json({ received: true, id: event.id });
  } catch (err) {
    if (isSarrafError(err, "WEBHOOK_SIGNATURE_INVALID")) {
      return Response.json({ error: "WEBHOOK_SIGNATURE_INVALID" }, { status: 400 });
    }
    return Response.json({ error: "WEBHOOK_PROCESSING_FAILED" }, { status: 500 });
  }
}
