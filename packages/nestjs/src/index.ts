// No emitDecoratorMetadata here (esbuild can't emit it): every injected dependency names its token.
import {
  BadRequestException,
  Controller,
  type DynamicModule,
  HttpCode,
  Inject,
  Injectable,
  InternalServerErrorException,
  Module,
  NotFoundException,
  type OnApplicationBootstrap,
  Param,
  Post,
  type Provider,
  Req,
  SetMetadata,
  type Type,
} from "@nestjs/common";
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import {
  isSarrafError,
  type Logger,
  type ProviderId,
  type RawWebhookRequest,
  Sarraf,
  type SarrafEvent,
  type SarrafOptions,
} from "@sarrafjs/core";

/** Injection token for the `Sarraf` client. Prefer `@InjectSarraf()`. */
export const SARRAF: unique symbol = Symbol.for("@sarrafjs/nestjs:client");
const MODULE_OPTIONS = Symbol.for("@sarrafjs/nestjs:options");
const EVENT_METADATA = "sarraf:on-event";

type EventType = SarrafEvent["type"];

/** Inject the `Sarraf` client registered by `SarrafModule`. */
export const InjectSarraf = (): PropertyDecorator & ParameterDecorator => Inject(SARRAF);

/**
 * Run this method for verified webhook events of the given types (all events when none are given).
 * It must live on a singleton provider or controller. Dedupe on `event.id`: providers retry.
 *
 * ```ts
 * @OnSarrafEvent("payment.succeeded")
 * async paid(event: PaymentEvent) { await this.orders.markPaid(event.payment.reference); }
 * ```
 */
export const OnSarrafEvent = (...types: EventType[]): MethodDecorator => SetMetadata(EVENT_METADATA, types);

export interface SarrafWebhookOptions {
  /** Controller path. The route is `POST /<path>/:provider`. Default "webhooks". */
  path?: string | undefined;
  /**
   * "handle-first" (default): run the handlers, then answer 200; a thrown error answers 500 so the
   * provider retries. "ack-first": answer 200 immediately and run the handlers after (enqueue only!).
   */
  mode?: "handle-first" | "ack-first" | undefined;
}

interface ModuleOptions {
  /** `false` registers no controller: call `SarrafWebhooks.handle()` from your own. */
  webhooks?: SarrafWebhookOptions | false | undefined;
  /** Default: the client's logger. */
  logger?: Logger | undefined;
}

export interface SarrafModuleOptions extends ModuleOptions {
  /** A `Sarraf` client, or the options to create one. */
  client: Sarraf | SarrafOptions;
}

export interface SarrafModuleAsyncOptions extends ModuleOptions {
  imports?: DynamicModule["imports"];
  inject?: (string | symbol | Type)[] | undefined;
  /** Returns a `Sarraf` client, or the options to create one (e.g. from `ConfigService`). */
  useFactory: (...deps: never[]) => Sarraf | SarrafOptions | Promise<Sarraf | SarrafOptions>;
}

/** The request fields `handle()` needs. Express and Fastify requests both fit. */
export interface WebhookRequestLike {
  headers: RawWebhookRequest["headers"];
  rawBody?: Buffer | string | undefined;
  query?: unknown;
}

interface Handler {
  types: EventType[];
  run: (event: SarrafEvent) => unknown;
  name: string;
}

/** Verifies webhooks and dispatches them to `@OnSarrafEvent()` methods. */
@Injectable()
export class SarrafWebhooks implements OnApplicationBootstrap {
  private handlers: Handler[] = [];

  constructor(
    @Inject(SARRAF) private readonly pay: Sarraf,
    @Inject(MODULE_OPTIONS) private readonly options: ModuleOptions,
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(MetadataScanner) private readonly scanner: MetadataScanner,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  private get logger(): Logger {
    return this.options.logger ?? this.pay.ctx.logger;
  }

  onApplicationBootstrap(): void {
    this.handlers = [];
    const wrappers = [...this.discovery.getProviders(), ...this.discovery.getControllers()];
    for (const wrapper of wrappers) {
      const instance: unknown = wrapper.instance;
      if (!instance || typeof instance !== "object") continue;
      const prototype = Object.getPrototypeOf(instance) as object | null;
      for (const method of this.scanner.getAllMethodNames(prototype)) {
        const fn = (instance as Record<string, unknown>)[method];
        if (typeof fn !== "function") continue;
        const types = this.reflector.get<EventType[] | undefined>(EVENT_METADATA, fn as () => unknown);
        if (!types) continue;
        if (!wrapper.isDependencyTreeStatic()) {
          this.logger.warn(`@OnSarrafEvent() on request-scoped ${wrapper.name}.${method} is ignored`);
          continue;
        }
        this.handlers.push({
          types,
          run: (event) => (fn as (e: SarrafEvent) => unknown).call(instance, event),
          name: `${String(wrapper.name)}.${method}`,
        });
      }
    }
  }

  /** Run every matching `@OnSarrafEvent()` handler, in registration order. */
  async dispatch(event: SarrafEvent): Promise<void> {
    for (const handler of this.handlers) {
      if (handler.types.length === 0 || handler.types.includes(event.type)) await handler.run(event);
    }
  }

  /**
   * Verify, normalize and dispatch one webhook. Throws Nest HTTP exceptions: 404 unknown provider,
   * 400 invalid signature, 500 missing raw body / processing or handler failure.
   */
  async handle(provider: string, req: WebhookRequestLike): Promise<{ received: true; id: string }> {
    if (!this.pay.providerIds.includes(provider as ProviderId)) {
      throw new NotFoundException({ error: "UNKNOWN_PROVIDER" });
    }
    if (req.rawBody === undefined) {
      this.logger.error(
        "SarrafWebhooks: req.rawBody is missing. Create the app with NestFactory.create(AppModule, { rawBody: true }).",
      );
      throw new InternalServerErrorException({ error: "RAW_BODY_MISSING" });
    }
    let event: SarrafEvent;
    try {
      event = await this.pay.webhooks.verifyAndParse(provider as ProviderId, {
        headers: req.headers,
        rawBody: req.rawBody,
        query: (req.query ?? {}) as Record<string, string>,
      });
    } catch (err) {
      if (isSarrafError(err, "WEBHOOK_SIGNATURE_INVALID")) {
        this.logger.warn(`rejected ${provider} webhook`, { reason: err.message });
        throw new BadRequestException({ error: "WEBHOOK_SIGNATURE_INVALID" });
      }
      this.logger.error(`failed to process ${provider} webhook`, { error: String(err) });
      throw new InternalServerErrorException({ error: "WEBHOOK_PROCESSING_FAILED" });
    }
    const mode = (this.options.webhooks || undefined)?.mode ?? "handle-first";
    if (mode === "ack-first") {
      this.dispatch(event).catch((err: unknown) => {
        this.logger.error(`event handler failed after ack for ${event.id}`, { error: String(err) });
      });
      return { received: true, id: event.id };
    }
    try {
      await this.dispatch(event);
    } catch (err) {
      this.logger.error(`event handler failed for ${event.id}; answering 500 so the provider retries`, {
        error: String(err),
      });
      throw new InternalServerErrorException({ error: "HANDLER_FAILED" });
    }
    return { received: true, id: event.id };
  }
}

function webhookController(path: string): Type {
  @Controller(path)
  class SarrafWebhookController {
    constructor(@Inject(SarrafWebhooks) private readonly webhooks: SarrafWebhooks) {}

    @Post(":provider")
    @HttpCode(200)
    async receive(@Param("provider") provider: string, @Req() req: WebhookRequestLike) {
      return this.webhooks.handle(provider, req);
    }
  }
  return SarrafWebhookController;
}

/** `instanceof` alone fails when the app and this package load different copies of core (ESM vs CJS). */
function isClient(value: Sarraf | SarrafOptions): value is Sarraf {
  return value instanceof Sarraf || typeof (value as Partial<Sarraf>).checkout === "object";
}

function toClient(value: Sarraf | SarrafOptions): Sarraf {
  return isClient(value) ? value : new Sarraf(value);
}

/**
 * Registers the `Sarraf` client (global, inject it with `@InjectSarraf()`) and a webhook controller
 * at `POST /webhooks/:provider`. Create the app with `{ rawBody: true }` so signatures can be checked.
 *
 * ```ts
 * @Module({ imports: [SarrafModule.forRoot({ client: { providers: { paymob: paymob({ ... }) } } })] })
 * export class AppModule {}
 * ```
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules are classes with static forRoot()
export class SarrafModule {
  static forRoot(options: SarrafModuleOptions): DynamicModule {
    const { client, ...rest } = options;
    return SarrafModule.build({ provide: SARRAF, useFactory: () => toClient(client) }, rest);
  }

  static forRootAsync(options: SarrafModuleAsyncOptions): DynamicModule {
    const { imports, inject, useFactory, ...rest } = options;
    return SarrafModule.build(
      {
        provide: SARRAF,
        inject: inject ?? [],
        useFactory: async (...deps: never[]) => toClient(await useFactory(...deps)),
      },
      rest,
      imports,
    );
  }

  private static build(
    client: Provider,
    options: ModuleOptions,
    imports: DynamicModule["imports"] = [],
  ): DynamicModule {
    return {
      module: SarrafModule,
      global: true,
      imports: [DiscoveryModule, ...imports],
      providers: [client, { provide: MODULE_OPTIONS, useValue: options }, SarrafWebhooks],
      controllers:
        options.webhooks === false ? [] : [webhookController(options.webhooks?.path ?? "webhooks")],
      exports: [SARRAF, SarrafWebhooks],
    };
  }
}
