import "server-only";
import type { Money, PaymentStatus, ProviderId, Sarraf, SarrafEvent } from "@sarrafjs/core";
import { createPay } from "./pay-factory";

export interface Order {
  reference: string;
  provider: ProviderId;
  quantity: number;
  amount: Money;
  refunded: Money;
  status: PaymentStatus;
  providerPaymentId?: string | undefined;
  referenceCode?: string | undefined;
  expiresAt?: string | undefined;
  createdAt: number;
}

export const PUBLIC_URL = process.env.PUBLIC_URL ?? "http://localhost:3002";

// Survive Next.js dev hot reloads. Use a real database in production.
const g = globalThis as unknown as {
  __sarraf?: { pay: Sarraf; demo: boolean } | undefined;
  __orders?: Map<string, Order> | undefined;
  __events?: Set<string> | undefined;
};

export function getPay() {
  g.__sarraf ??= createPay({ publicUrl: PUBLIC_URL });
  return g.__sarraf;
}

g.__orders ??= new Map<string, Order>();
g.__events ??= new Set<string>();
export const orders = g.__orders;
export const processedEvents = g.__events;

/** The one place order state changes: a verified, deduplicated webhook event. */
export function applyEvent(event: SarrafEvent): void {
  if (processedEvents.has(event.id)) return; // dedupe: providers retry
  processedEvents.add(event.id);
  const order = orders.get(event.payment.reference);
  if (!order) return;
  order.status = event.payment.status;
  order.refunded = event.payment.amountRefunded;
  order.providerPaymentId ??= event.payment.providerPaymentId;
}
