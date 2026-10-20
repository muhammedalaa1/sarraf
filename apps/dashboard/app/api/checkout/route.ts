import { type PaymentMethod, type ProviderId, isSarrafError, toMinor } from "@sarraf/core";
import type { FakeProvider } from "@sarraf/testing";
import { clientKey, limits, tooMany } from "../../../lib/rate-limit";
import { getSarraf } from "../../../lib/sarraf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  provider: ProviderId;
  amount: string;
  method?: PaymentMethod | undefined;
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
    methods: body.method ? [body.method] : undefined,
    returnUrl: `${origin}/inbox`,
    webhookUrl: `${origin}/webhooks/${body.provider}`,
    expiresInSeconds: 3600,
  };
  httpLog.length = 0;
  try {
    input.amount.value = toMinor(String(body.amount ?? "0"), "EGP");
    const checkout = await pay.checkout.create(input);
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
