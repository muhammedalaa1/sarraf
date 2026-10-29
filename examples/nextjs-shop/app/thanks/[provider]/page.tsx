import { verifyRedirect } from "@sarrafjs/next";
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
  // Not every provider signs redirects (then authenticated is false). The webhook remains the source of truth.
  const r = await verifyRedirect(pay, provider, query);
  const reference = r.reference ?? query.reference;
  const declined = r.authenticated && r.status === "failed";
  const order = reference ? orders.get(reference) : undefined;
  if (!order) notFound();
  const message = declined
    ? { error: "The payment did not go through. You can try again from the shop." }
    : order.status === "succeeded"
      ? { notice: "Thanks! Your payment is confirmed." }
      : { notice: "Thanks! Your order is confirmed as soon as the provider notifies us." };
  redirect(`/orders/${order.reference}?${new URLSearchParams(message)}`);
}
