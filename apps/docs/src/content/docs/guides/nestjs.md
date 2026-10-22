---
title: NestJS
description: SarrafModule, verified webhooks and @OnSarrafEvent handlers in NestJS.
sidebar:
  order: 2
---

```bash
npm install @sarrafjs/nestjs
```

Enable raw bodies when you bootstrap the app. Signatures are computed over the exact bytes:

```ts
const app = await NestFactory.create(AppModule, { rawBody: true });
```

## Register the module

```ts
import { SarrafModule } from "@sarrafjs/nestjs";

@Module({
  imports: [
    SarrafModule.forRoot({
      client: { providers: { paymob: paymob({ /* … */ }), fawry: fawry({ /* … */ }) } },
    }),
  ],
})
export class AppModule {}
```

`client` is either a `Sarraf` instance or the options to create one. To read keys from `ConfigService`:

```ts
SarrafModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    providers: { kashier: kashier({ merchantId: config.getOrThrow("KASHIER_MERCHANT_ID"), /* … */ }) },
  }),
});
```

The module is global. Inject the client anywhere with `@InjectSarraf()`:

```ts
@Injectable()
export class CheckoutService {
  constructor(@InjectSarraf() private readonly pay: Sarraf) {}
}
```

## Handle webhooks

The module serves `POST /webhooks/:provider`. Verified events go to every method marked `@OnSarrafEvent()`:

```ts
import { OnSarrafEvent } from "@sarrafjs/nestjs";

@Injectable()
export class OrdersService {
  @OnSarrafEvent("payment.succeeded")
  async paid(event: SarrafEvent) {
    await this.orders.markPaid(event.payment.reference); // dedupe on event.id
  }

  @OnSarrafEvent() // no types: every event
  async log(event: SarrafEvent) { /* … */ }
}
```

| Status | When |
|---|---|
| 200 | Verified, and every matching handler finished |
| 400 | `WEBHOOK_SIGNATURE_INVALID` |
| 404 | Unknown provider |
| 500 | Missing raw body, processing failed, or a handler threw, so the provider retries |

Handlers must be on singleton providers or controllers; request-scoped ones are ignored with a warning.

Options, on both `forRoot` and `forRootAsync`:

- `webhooks: { path: "payments/webhooks" }` changes the route to `POST /payments/webhooks/:provider`.
- `webhooks: { mode: "ack-first" }` answers 200 before running handlers. Errors are then only logged, so only enqueue work.
- `webhooks: false` registers no controller. Call `SarrafWebhooks.handle(provider, req)` from your own controller instead; it throws the same HTTP exceptions.

Full example: [`examples/nestjs-shop`](https://github.com/muhammedalaa1/Sarraf/tree/main/examples/nestjs-shop).
