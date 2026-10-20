import { inbox } from "../../../../../lib/inbox";
import { getSarraf } from "../../../../../lib/sarraf";
import { replayWebhook } from "../../../../../lib/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const entry = await replayWebhook(getSarraf().pay, inbox, id);
  if (!entry) return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  return Response.json(entry);
}
