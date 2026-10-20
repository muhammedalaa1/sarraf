---
title: NestJS
description: Raw-body webhooks and a Sarraf provider in NestJS.
sidebar:
  order: 2
---

Enable raw bodies when you bootstrap the app:

```ts
const app = await NestFactory.create(AppModule, { rawBody: true });
```

Provide Sarraf with a token:

```ts
export const SARRAF = Symbol("SARRAF");

@Module({
  controllers: [PaymentsController],
  providers: [{ provide: SARRAF, useFactory: () => new Sarraf({ providers: { /* … */ } }) }],
})
export class AppModule {}
```

Verify in a controller:

```ts
@Post("webhooks/:provider")
@HttpCode(200)
async webhook(@Param("provider") provider: ProviderId, @Req() req: RawBodyRequest<Request>) {
  try {
    const event = await this.pay.webhooks.verifyAndParse(provider, {
      headers: req.headers,
      rawBody: req.rawBody!,
      query: req.query as Record<string, string>,
    });
    await this.orders.apply(event);   // dedupe on event.id
    return { received: true };
  } catch (err) {
    if (isSarrafError(err, "WEBHOOK_SIGNATURE_INVALID")) throw new BadRequestException();
    throw err;
  }
}
```

Full example: [`examples/nestjs-shop`](https://github.com/sarraf-dev/sarraf/tree/main/examples/nestjs-shop).
