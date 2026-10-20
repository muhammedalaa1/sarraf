import { inbox } from "../../../lib/inbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(inbox.list());
}

export async function DELETE() {
  inbox.clear();
  return Response.json({ cleared: true });
}
