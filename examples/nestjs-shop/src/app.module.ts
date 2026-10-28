import "reflect-metadata";
import { BadRequestException, Body, Controller, Get, Inject, Injectable, Module, Post } from "@nestjs/common";
import {
  isSarrafError,
  type PaymentStatus,
  type ProviderId,
  type Sarraf,
  type SarrafEvent,
} from "@sarraf/core";
import { InjectSarraf, OnSarrafEvent, SarrafModule } from "@sarraf/nestjs";
import { createPay } from "./pay.js";

export interface Order {
  reference: string;
  provider: ProviderId;
  status: PaymentStatus;
}

@Injectable()
export class OrdersService {
  readonly orders = new Map<string, Order>();
  readonly processedEvents = new Set<string>();

  /**
   * Every verified webhook lands here. SarrafModule serves POST /webhooks/:provider, which needs
   * NestFactory.create(AppModule, { rawBody: true }) so signatures are checked over the exact bytes.
   */
  @OnSarrafEvent()
  apply(event: SarrafEvent) {
    if (this.processedEvents.has(event.id)) return; // dedupe: providers retry
    this.processedEvents.add(event.id);
    if (event.type === "card.saved") return; // this shop does not keep saved cards
    const order = this.orders.get(event.payment.reference);
    if (order) order.status = event.payment.status;
  }
}

@Controller()
export class PaymentsController {
  constructor(
    @InjectSarraf() private readonly pay: Sarraf,
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

  @Get("orders")
  list() {
    return [...this.orders.orders.values()];
  }
}

@Module({
  imports: [SarrafModule.forRootAsync({ useFactory: () => createPay().pay })],
  controllers: [PaymentsController],
  providers: [OrdersService],
})
export class AppModule {}
