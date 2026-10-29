# @sarraf/nestjs

NestJS module for [Sarraf](https://github.com/muhammedalaa1/sarraf).

```ts
// main.ts: signatures need the exact request bytes
const app = await NestFactory.create(AppModule, { rawBody: true });
```

```ts
import { InjectSarraf, OnSarrafEvent, SarrafModule } from "@sarraf/nestjs";

@Module({ imports: [SarrafModule.forRoot({ client: { providers: { kashier: kashier({ ... }) } } })] })
export class AppModule {}

@Injectable()
export class OrdersService {
  constructor(@InjectSarraf() private readonly pay: Sarraf) {}

  @OnSarrafEvent("payment.succeeded")
  async paid(event: PaymentEvent) {
    // dedupe on event.id, then fulfil the order
  }
}
```

- `SarrafModule.forRoot({ client })` or `forRootAsync({ inject, useFactory })` registers the client globally; inject it with `@InjectSarraf()`.
- The module serves `POST /webhooks/:provider`: it verifies the signature and calls every `@OnSarrafEvent()` method that matches. It answers 404 for unknown providers, 400 for invalid signatures, and 500 when a handler throws, so the provider retries.
- `webhooks: { path }` changes the route, `webhooks: { mode: "ack-first" }` answers before running handlers, and `webhooks: false` lets you call `SarrafWebhooks.handle()` from your own controller.

> Not affiliated with any payment provider. Part of [Sarraf](https://github.com/muhammedalaa1/sarraf). Apache-2.0.
