import type { ProviderId } from "@sarraf/core";
import { notFound, redirect } from "next/navigation";
import { getPay, orders } from "../../../lib/pay";

export const dynamic = "force-dynamic";

/**
 * The provider sends the customer back here. Redirect params are for UX only: they decide which
 * message to show, never the order status (that comes from the webhook).
 */
export default async function Thanks({
  params,
  searchParams,
}: {
  params: Promise<{ provider: string }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const { provider } = await params;
  const query = await searchParams;
  const { pay } = getPay();
  let reference = query.reference;
  let declined = false;
  try {
    const r = await pay.redirects.verify(provider as ProviderId, query);
    reference = r.reference ?? reference;
    declined = r.authenticated && r.status === "failed";
  } catch {
    // Not every provider signs redirects. The webhook remains the source of truth.
  }
  const order = reference ? orders.get(reference) : undefined;
  if (!order) notFound();
  const message = declined
    ? { error: "The payment did not go through. You can try again from the shop." }
    : order.status === "succeeded"
      ? { notice: "Thanks! Your payment is confirmed." }
      : { notice: "Thanks! Your order is confirmed as soon as the provider notifies us." };
  redirect(`/orders/${order.reference}?${new URLSearchParams(message)}`);
}
