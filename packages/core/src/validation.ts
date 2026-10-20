import { z } from "zod";
import { SarrafError } from "./errors.js";
import { CURRENCIES } from "./money.js";
import type { CreateCheckoutInput, Currency, RefundInput } from "./types.js";

const currency = z.enum(CURRENCIES as [Currency, ...Currency[]]);
export const moneySchema = z.object({
  value: z.number().int("must be an integer in minor units").nonnegative().safe(),
  currency,
});

const method = z.enum(["card", "wallet", "cash_outlet", "installments", "bnpl", "bank_transfer", "other"]);

export const createCheckoutSchema = z
  .object({
    provider: z.string().min(1),
    amount: moneySchema.refine((m) => m.value > 0, "must be greater than zero"),
    reference: z.string().min(1).max(200),
    customer: z.object({
      name: z.string().optional(),
      email: z.string().email().optional(),
      phone: z.string().min(6, "is required by most providers"),
    }),
    items: z
      .array(
        z.object({
          name: z.string().min(1),
          unitAmount: moneySchema,
          quantity: z.number().int().positive(),
          sku: z.string().optional(),
        }),
      )
      .optional(),
    methods: z.array(method).nonempty().optional(),
    returnUrl: z.string().url().optional(),
    webhookUrl: z.string().url().optional(),
    expiresInSeconds: z.number().int().positive().optional(),
    locale: z.enum(["en", "ar"]).optional(),
    idempotencyKey: z.string().min(1).max(255).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    providerOptions: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((input, ctx) => {
    if (!input.items?.length) return;
    let total = 0;
    for (const [i, item] of input.items.entries()) {
      if (item.unitAmount.currency !== input.amount.currency) {
        ctx.addIssue({
          code: "custom",
          path: ["items", i, "unitAmount"],
          message: "currency must match amount",
        });
      }
      total += item.unitAmount.value * item.quantity;
    }
    if (total !== input.amount.value) {
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: `items total ${total} must equal amount ${input.amount.value}`,
      });
    }
  });

export const refundSchema = z.object({
  providerPaymentId: z.string().min(1),
  reference: z.string().optional(),
  amount: moneySchema.refine((m) => m.value > 0, "must be greater than zero").optional(),
  reason: z.string().max(500).optional(),
  idempotencyKey: z.string().min(1).max(255).optional(),
});

export function validateCheckoutInput(input: CreateCheckoutInput): void {
  check(createCheckoutSchema, input, "checkout.create");
}

export function validateRefundInput(input: RefundInput): void {
  check(refundSchema, input, "refunds.create");
}

function check(schema: z.ZodTypeAny, input: unknown, op: string) {
  const result = schema.safeParse(input);
  if (result.success) return;
  const issues = result.error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ");
  const unsupportedCurrency = result.error.issues.some(
    (i) => i.path[i.path.length - 1] === "currency" && i.code === "invalid_value",
  );
  throw new SarrafError(unsupportedCurrency ? "UNSUPPORTED_CURRENCY" : "INVALID_REQUEST", `${op}: ${issues}`);
}
