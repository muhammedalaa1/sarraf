import "reflect-metadata";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  type RawBodyRequest,
  Req,
} from "@nestjs/common";
import { isSarrafError, type PaymentStatus, type ProviderId, type Sarraf } from "@sarraf/core";
import type { Request } from "express";
import { createPay } from "./pay.js";

export const SARRAF = Symbol("SARRAF");

export interface Order {
  reference: string;
  provider: ProviderId;
  status: PaymentStatus;
}

@Injectable()
export class OrdersService {
  readonly orders = new Map<string, Order>();
  readonly processedEvents = new Set<string>();
}

@Controller()
export class PaymentsController {
  constructor(
    @Inject(SARRAF) private readonly pay: Sarraf,
    @Inject(OrdersService) private readonly orders: OrdersService,
  ) {}

  @Post("checkout")
  async checkout(@Body() body: { provider: ProviderId; amount: number; phone: string }) {
    const reference = `order_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    try {
      const checkout = await this.pay.checkout.create({
        provider: body.provider,
        amount: { value: body.amount, currency: "EGP" },
        reference,
        customer: { phone: body.phone },
        idempotencyKey: reference,
      });
      this.orders.orders.set(reference, {
        reference,
        provider: body.provider,
        status: checkout.payment.status,
      });
      return {
        reference,
        kind: checkout.kind,
        redirectUrl: checkout.redirectUrl,
        referenceCode: checkout.referenceCode,
      };
    } catch (err) {
      if (isSarrafError(err)) throw new BadRequestException({ code: err.code, message: err.message });
      throw err;
    }
  }

  /** NestFactory.create(AppModule, { rawBody: true }) puts the exact bytes on req.rawBody. */
  @Post("webhooks/:provider")
  @HttpCode(200)
  async webhook(@Param("provider") provider: ProviderId, @Req() req: RawBodyRequest<Request>) {
    if (!this.pay.providerIds.includes(provider)) throw new NotFoundException();
    try {
      const event = await this.pay.webhooks.verifyAndParse(provider, {
        headers: req.headers,
        rawBody: req.rawBody ?? "",
        query: req.query as Record<string, string>,
      });
      if (!this.orders.processedEvents.has(event.id)) {
        this.orders.processedEvents.add(event.id);
        const order = this.orders.orders.get(event.payment.reference);
        if (order) order.status = event.payment.status;
      }
      return { received: true, id: event.id };
    } catch (err) {
      if (isSarrafError(err, "WEBHOOK_SIGNATURE_INVALID")) throw new BadRequestException("invalid signature");
      throw err;
    }
  }

  @Get("orders")
  list() {
    return [...this.orders.orders.values()];
  }
}

@Module({
  controllers: [PaymentsController],
  providers: [OrdersService, { provide: SARRAF, useFactory: () => createPay().pay }],
})
export class AppModule {}
