import { isSarrafError, type PaymentMethod, type ProviderId, toMinor } from "@sarrafjs/core";
import type { FakeProvider } from "@sarrafjs/testing";
import { AUTHORIZE_ONLY } from "../../../lib/methods";
import { orders, withoutRaw } from "../../../lib/orders";
import { clientKey, limits, tooMany } from "../../../lib/rate-limit";
import { getSarraf } from "../../../lib/sarraf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  provider: ProviderId;
  amount: string;
  method?: PaymentMethod | typeof AUTHORIZE_ONLY | undefined;
  phone?: string | undefined;
  email?: string | undefined;
}

export async function POST(req: Request) {
  if (!limits.checkout.take(clientKey(req))) return tooMany();
  const { pay, demo, httpLog } = getSarraf();
  const body = (await req.json().catch(() => ({}))) as Body;
  const origin = process.env.SANDBOX_PUBLIC_URL ?? new URL(req.url).origin;
  const input = {
    provider: body.provider,
    amount: { value: 0, currency: "EGP" as const },
    reference: `sbx_${Date.now()}_${Math.floor(Math.random() * 1e4)}`,
    customer: {
      phone: body.phone || "+201000000000",
      email: body.email || undefined,
      name: "Sandbox Tester",
    },
    methods: body.method === AUTHORIZE_ONLY ? ["card" as const] : body.method ? [body.method] : undefined,
    providerOptions: body.method === AUTHORIZE_ONLY ? { capture: "manual" as const } : undefined,
    returnUrl: `${origin}/inbox`,
    webhookUrl: `${origin}/webhooks/${body.provider}`,
    expiresInSeconds: 3600,
  };
  httpLog.length = 0;
  try {
    input.amount.value = toMinor(String(body.amount ?? "0"), "EGP");
    const checkout = await pay.checkout.create(input);
    orders.upsert(
      input.provider,
      input.reference,
      {
        amount: input.amount,
        redirectUrl: checkout.redirectUrl,
        referenceCode: checkout.referenceCode,
        payment: checkout.payment ? withoutRaw(checkout.payment) : undefined,
      },
      { action: "checkout", ok: true, summary: `checkout created (${checkout.kind})` },
    );
    let demoWebhook: unknown;
    if (demo) {
      // Demo mode: fake a signed "succeeded" webhook so the inbox has something to show.
      const fake = pay.provider(body.provider) as unknown as FakeProvider<ProviderId>;
      demoWebhook = fake.simulate(input.reference, "succeeded");
    }
    return Response.json({
      input,
      checkout,
      normalized: checkout.payment,
      http: [...httpLog],
      demo,
      demoWebhook,
    });
  } catch (err) {
    return Response.json(
      {
        input,
        http: [...httpLog],
        error: isSarrafError(err)
          ? err.toJSON()
          : { message: err instanceof Error ? err.message : String(err) },
      },
      { status: 400 },
    );
  }
}
