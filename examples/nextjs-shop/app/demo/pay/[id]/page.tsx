import { notFound } from "next/navigation";
import { getPay, orders } from "../../../../lib/pay";
import { PROVIDER_INFO, formatMoney } from "../../../../lib/shop";
import { demoPay } from "../../../actions";

export const dynamic = "force-dynamic";

/** Demo mode only: stands in for the provider's hosted payment page. */
export default async function FakeCheckout({
  searchParams,
}: {
  searchParams: Promise<{ reference?: string }>;
}) {
  const { reference } = await searchParams;
  const order = reference ? orders.get(reference) : undefined;
  if (!getPay().demo || !order) notFound();
  const provider = PROVIDER_INFO[order.provider].label;
  return (
    <div className="card fake-checkout stack">
      <div className="provider-tag">{provider} · fake hosted checkout</div>
      <h1>{formatMoney(order.amount)}</h1>
      <p className="muted small">
        In a real integration this is {provider}&apos;s page. Choose an outcome: the provider then sends a
        signed webhook to the shop, and you are redirected back.
      </p>
      <form action={demoPay.bind(null, order.reference)} className="stack">
        <button className="block" name="outcome" value="succeeded" type="submit">
          Approve payment
        </button>
        <button className="block secondary" name="outcome" value="failed" type="submit">
          Decline
        </button>
      </form>
    </div>
  );
}
