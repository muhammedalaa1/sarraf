import { getSarraf } from "../../lib/sarraf";
import { Operations } from "./operations";

export const dynamic = "force-dynamic";

export default function OperationsPage() {
  const { pay, demo } = getSarraf();
  const providers = pay.providerIds.map((id) => {
    const caps = pay.capabilities(id);
    return {
      id,
      lookup: caps.getPayment !== "unsupported",
      refund: caps.refund !== "unsupported",
      partialRefund: caps.partialRefund !== "unsupported",
      cancel: caps.cancel !== "unsupported",
    };
  });
  return (
    <>
      <h1>Operations</h1>
      <p className="lead">
        Every checkout created in the playground lands here. Pay it on the hosted page, then reconcile, refund
        or void it and compare the request, the raw response and the normalized result.
      </p>
      <Operations providers={providers} demo={demo} />
    </>
  );
}
