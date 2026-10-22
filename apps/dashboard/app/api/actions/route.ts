import { type ActionBody, runAction } from "../../../lib/actions";
import { orders } from "../../../lib/orders";
import { clientKey, limits, tooMany } from "../../../lib/rate-limit";
import { getSarraf } from "../../../lib/sarraf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reconcile, refund or void an order. Body: ActionBody. */
export async function POST(req: Request) {
  if (!limits.actions.take(clientKey(req))) return tooMany();
  const { pay, httpLog } = getSarraf();
  const body = (await req.json().catch(() => ({}))) as ActionBody;
  httpLog.length = 0;
  const out = await runAction(pay, orders, body);
  return Response.json({ ...out, input: body, http: [...httpLog] }, { status: out.ok ? 200 : 400 });
}
