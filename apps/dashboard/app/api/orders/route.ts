import { orders } from "../../../lib/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(orders.list());
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const provider = url.searchParams.get("provider");
  const reference = url.searchParams.get("reference");
  if (provider && reference) orders.remove(provider as never, reference);
  else orders.clear();
  return Response.json({ cleared: true });
}
