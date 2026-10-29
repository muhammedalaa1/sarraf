import "reflect-metadata";
import {
  Controller,
  type INestApplication,
  Inject,
  Injectable,
  Module,
  Post,
  Req,
  Scope,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type PaymentEvent, Sarraf, type SarrafEvent, silentLogger } from "@sarrafjs/core";
import { type FakeProvider, fakeProvider } from "@sarrafjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InjectSarraf,
  OnSarrafEvent,
  SARRAF,
  SarrafModule,
  type SarrafModuleOptions,
  SarrafWebhooks,
  type WebhookRequestLike,
} from "../src/index.js";

const seen: string[] = [];
let failWith: Error | undefined;

@Injectable()
class OrdersHandler {
  constructor(@InjectSarraf() readonly pay: Sarraf) {}

  @OnSarrafEvent("payment.succeeded")
  async paid(event: PaymentEvent) {
    if (failWith) throw failWith;
    seen.push(`paid:${event.payment.reference}`);
  }

  @OnSarrafEvent()
  all(event: SarrafEvent) {
    seen.push(`all:${event.type}`);
  }

  notAHandler() {
    return "ignored";
  }
}

@Injectable({ scope: Scope.REQUEST })
class RequestScopedHandler {
  @OnSarrafEvent()
  never() {
    seen.push("request-scoped");
  }
}

async function newPay() {
  const pay = new Sarraf({ providers: { paymob: fakeProvider("paymob") }, logger: silentLogger });
  await pay.checkout.create({
    provider: "paymob",
    amount: { value: 100, currency: "EGP" },
    reference: "o1",
    customer: { phone: "0100000000" },
  });
  return { pay, fake: pay.provider("paymob") as unknown as FakeProvider<"paymob"> };
}

let app: INestApplication | undefined;

async function start(imports: unknown[], opts: { rawBody?: boolean; providers?: unknown[] } = {}) {
  const ref = await Test.createTestingModule({
    imports: imports as never,
    providers: (opts.providers ?? [OrdersHandler]) as never,
  }).compile();
  app = ref.createNestApplication({ rawBody: opts.rawBody ?? true, logger: false });
  await app.init();
  return app;
}

function send(server: unknown, path: string, webhook: { rawBody: unknown; headers?: unknown }) {
  return request(server as never)
    .post(path)
    .set((webhook.headers ?? { "content-type": "application/json" }) as Record<string, string>)
    .send(webhook.rawBody as string);
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  seen.length = 0;
  failWith = undefined;
});

describe("SarrafModule.forRoot", () => {
  it("injects the client and dispatches verified webhooks to @OnSarrafEvent handlers", async () => {
    const { pay, fake } = await newPay();
    const nest = await start([SarrafModule.forRoot({ client: pay })]);
    expect(nest.get(OrdersHandler).pay).toBe(pay);
    expect(nest.get(SARRAF)).toBe(pay);
    const res = await send(nest.getHttpServer(), "/webhooks/paymob", fake.simulate("o1", "succeeded"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, id: "paymob:1:succeeded" });
    expect(seen).toEqual(["paid:o1", "all:payment.succeeded"]);
    await send(nest.getHttpServer(), "/webhooks/paymob", fake.simulate("o1", "failed"));
    expect(seen.slice(2)).toEqual(["all:payment.failed"]);
  });

  it("creates the client from options", async () => {
    const options: SarrafModuleOptions = {
      client: { providers: { kashier: fakeProvider("kashier") }, logger: silentLogger },
    };
    const nest = await start([SarrafModule.forRoot(options)]);
    expect(nest.get<Sarraf>(SARRAF).providerIds).toEqual(["kashier"]);
  });

  it("answers 404, 400 and 500 like the other framework helpers", async () => {
    const { pay, fake } = await newPay();
    const nest = await start([SarrafModule.forRoot({ client: pay })]);
    const server = nest.getHttpServer();
    expect((await send(server, "/webhooks/stripe", { rawBody: "{}" })).body).toMatchObject({
      error: "UNKNOWN_PROVIDER",
    });
    const webhook = fake.simulate("o1", "succeeded");
    const bad = await send(server, "/webhooks/paymob", {
      rawBody: webhook.rawBody,
      headers: { ...(webhook.headers as Record<string, string>), "x-sarraf-fake-signature": "00" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: "WEBHOOK_SIGNATURE_INVALID" });

    failWith = new Error("db down");
    const failed = await send(server, "/webhooks/paymob", webhook);
    expect(failed.status).toBe(500);
    expect(failed.body).toMatchObject({ error: "HANDLER_FAILED" });

    failWith = undefined;
    fake.parseWebhook = async () => {
      throw new Error("boom");
    };
    const broken = await send(server, "/webhooks/paymob", webhook);
    expect(broken.status).toBe(500);
    expect(broken.body).toMatchObject({ error: "WEBHOOK_PROCESSING_FAILED" });
    expect(seen).toEqual([]);
  });

  it("explains a missing raw body", async () => {
    const { pay, fake } = await newPay();
    const logger = { ...silentLogger, error: vi.fn() };
    const nest = await start([SarrafModule.forRoot({ client: pay, logger })], { rawBody: false });
    const res = await send(nest.getHttpServer(), "/webhooks/paymob", fake.simulate("o1", "succeeded"));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: "RAW_BODY_MISSING" });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("rawBody: true"));
  });

  it("acks first, then logs handler errors (ack-first)", async () => {
    const { pay, fake } = await newPay();
    const logger = { ...silentLogger, error: vi.fn() };
    const nest = await start([
      SarrafModule.forRoot({ client: pay, logger, webhooks: { mode: "ack-first" } }),
    ]);
    failWith = new Error("queue down");
    const res = await send(nest.getHttpServer(), "/webhooks/paymob", fake.simulate("o1", "succeeded"));
    expect(res.status).toBe(200);
    await vi.waitFor(() =>
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("after ack"), expect.anything()),
    );
    failWith = undefined;
    await send(nest.getHttpServer(), "/webhooks/paymob", fake.simulate("o1", "succeeded"));
    await vi.waitFor(() => expect(seen).toContain("paid:o1"));
  });

  it("ignores request-scoped handlers with a warning", async () => {
    const { pay, fake } = await newPay();
    const logger = { ...silentLogger, warn: vi.fn() };
    const nest = await start([SarrafModule.forRoot({ client: pay, logger })], {
      providers: [RequestScopedHandler],
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("request-scoped"));
    await send(nest.getHttpServer(), "/webhooks/paymob", fake.simulate("o1", "succeeded"));
    expect(seen).toEqual([]);
  });
});

describe("SarrafModule.forRootAsync", () => {
  const CONFIG = "CONFIG";

  @Module({ providers: [{ provide: CONFIG, useValue: { secret: "s" } }], exports: [CONFIG] })
  class ConfigModule {}

  it("builds the client from injected config, on a custom path", async () => {
    const { pay, fake } = await newPay();
    const factory = vi.fn(async (_config: { secret: string }) => pay);
    const nest = await start([
      SarrafModule.forRootAsync({
        imports: [ConfigModule],
        inject: [CONFIG],
        useFactory: factory as never,
        webhooks: { path: "payments/hooks" },
      }),
    ]);
    expect(factory).toHaveBeenCalledWith({ secret: "s" });
    const res = await send(nest.getHttpServer(), "/payments/hooks/paymob", fake.simulate("o1", "succeeded"));
    expect(res.status).toBe(200);
    expect(seen).toContain("paid:o1");
  });

  it("accepts options from the factory without inject", async () => {
    const nest = await start([
      SarrafModule.forRootAsync({
        useFactory: () => ({ providers: { fawry: fakeProvider("fawry") }, logger: silentLogger }),
      }),
    ]);
    expect(nest.get<Sarraf>(SARRAF).providerIds).toEqual(["fawry"]);
  });

  it("registers no controller with webhooks: false; SarrafWebhooks.handle works from your own", async () => {
    @Controller("custom")
    class CustomController {
      constructor(@Inject(SarrafWebhooks) private readonly webhooks: SarrafWebhooks) {}

      @Post()
      receive(@Req() req: WebhookRequestLike) {
        return this.webhooks.handle("paymob", req);
      }
    }
    @Module({ controllers: [CustomController] })
    class CustomModule {}

    const { pay, fake } = await newPay();
    const nest = await start([
      SarrafModule.forRootAsync({ useFactory: () => pay, webhooks: false }),
      CustomModule,
    ]);
    const server = nest.getHttpServer();
    expect((await send(server, "/webhooks/paymob", fake.simulate("o1", "succeeded"))).status).toBe(404);
    const res = await send(server, "/custom", fake.simulate("o1", "succeeded"));
    expect(res.status).toBe(201);
    expect(seen).toEqual(["paid:o1", "all:payment.succeeded"]);
  });
});
