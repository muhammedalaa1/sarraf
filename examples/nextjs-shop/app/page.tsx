import { getPay } from "../lib/pay";
import { MAX_QUANTITY, PRODUCT, PROVIDER_INFO, formatMoney } from "../lib/shop";
import { checkout } from "./actions";
import { Notice } from "./components";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { pay } = getPay();
  const { error } = await searchParams;
  const quantities = Array.from({ length: MAX_QUANTITY }, (_, i) => i + 1);
  return (
    <div className="grid">
      <section className="card">
        <div className="product-art" aria-hidden="true">
          📓
        </div>
        <h1>{PRODUCT.name}</h1>
        <p className="muted">{PRODUCT.description}</p>
        <p className="price">{formatMoney(PRODUCT.price)}</p>
      </section>

      <section className="card">
        <form action={checkout} className="stack">
          <h2>Checkout</h2>
          <Notice text={error} tone="bad" />
          <div>
            <label htmlFor="quantity">Quantity</label>
            <select id="quantity" name="quantity" defaultValue="1">
              {quantities.map((n) => (
                <option key={n} value={n}>
                  {n} · {formatMoney({ value: PRODUCT.price.value * n, currency: PRODUCT.price.currency })}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="phone">Phone</label>
            <input
              id="phone"
              name="phone"
              type="tel"
              autoComplete="tel"
              defaultValue="+201001234567"
              required
            />
          </div>
          <fieldset>
            <legend>Pay with</legend>
            <div className="options">
              {pay.providerIds.map((p, i) => (
                <label key={p} className="option">
                  <input type="radio" name="provider" value={p} defaultChecked={i === 0} />
                  <div>
                    <strong>{PROVIDER_INFO[p].label}</strong>
                    <span>{PROVIDER_INFO[p].detail}</span>
                  </div>
                </label>
              ))}
            </div>
          </fieldset>
          <button className="block" type="submit">
            Continue to payment
          </button>
          <p className="muted small">
            You will be sent to the provider&apos;s page, or get a Fawry code to pay in cash.
          </p>
        </form>
      </section>
    </div>
  );
}
