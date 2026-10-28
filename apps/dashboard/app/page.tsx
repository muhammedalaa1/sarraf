import { AUTHORIZE_ONLY } from "../lib/methods";
import { getSarraf } from "../lib/sarraf";
import { Playground } from "./playground";

export const dynamic = "force-dynamic";

export default function Page() {
  const { pay } = getSarraf();
  const providers = pay.providerIds.map((id) => ({
    id,
    methods: [
      ...Object.entries(pay.capabilities(id).methods)
        .filter(([, level]) => level !== "unsupported")
        .map(([m]) => m),
      ...(pay.capabilities(id).capture === "unsupported" ? [] : [AUTHORIZE_ONLY]),
    ],
  }));
  return (
    <>
      <h1>Playground</h1>
      <p className="lead">
        Create a sandbox checkout with any provider and compare the request, the raw response and the
        normalized object.
      </p>
      <Playground providers={providers} />
    </>
  );
}
