/**
 * Compile-time contract for the public types. `pnpm typecheck` fails if any of these regress:
 * an `@ts-expect-error` line that stops erroring is itself an error.
 */
import {
  type Checkout,
  isSarrafError,
  type Money,
  type Payment,
  type PaymentStatus,
  Sarraf,
  type SarrafError,
  type SarrafEvent,
} from "@sarraf/core";
import { expectTypeOf } from "expect-type";
import { describe, it } from "vitest";
import { paymob } from "../src/index.js";

const pay = new Sarraf({
  providers: {
    paymob: paymob({
      secretKey: "sk_test_x",
      publicKey: "pk_test_x",
      hmacSecret: "h",
      integrationIds: { card: 1 },
    }),
  },
});

describe("public types", () => {
  it("checkout.create is typed per configured provider", () => {
    expectTypeOf(pay.checkout.create).returns.resolves.toEqualTypeOf<Checkout>();

    const input = {
      provider: "paymob",
      amount: { value: 1000, currency: "EGP" },
      reference: "r",
      customer: { phone: "+201000000000" },
    } as const;
    expectTypeOf(pay.checkout.create).toBeCallableWith(input);

    // @ts-expect-error: kashier is not configured on this client
    expectTypeOf(pay.checkout.create).toBeCallableWith({ ...input, provider: "kashier" });

    // @ts-expect-error: amounts are Money objects in minor units, never bare numbers
    expectTypeOf(pay.checkout.create).toBeCallableWith({ ...input, amount: 1000 });

    const badCurrency = { value: 1000, currency: "XYZ" } as const;
    // @ts-expect-error: unknown currency codes are rejected at compile time
    expectTypeOf(pay.checkout.create).toBeCallableWith({ ...input, amount: badCurrency });

    // @ts-expect-error: reference is required
    expectTypeOf(pay.checkout.create).toBeCallableWith({ ...input, reference: undefined });
  });

  it("providerOptions are narrowed to the provider's own options", () => {
    expectTypeOf(pay.checkout.create).toBeCallableWith({
      provider: "paymob",
      amount: { value: 1000, currency: "EGP" },
      reference: "r",
      customer: { phone: "+201000000000" },
      providerOptions: { paymentMethods: [123], extras: { a: 1 } },
    });

    expectTypeOf(pay.checkout.create).toBeCallableWith({
      provider: "paymob",
      amount: { value: 1000, currency: "EGP" },
      reference: "r",
      customer: { phone: "+201000000000" },
      // @ts-expect-error: paymentMethods must be ids or names, not booleans
      providerOptions: { paymentMethods: [true] },
    });
  });

  it("models expose closed unions", () => {
    expectTypeOf<Money["value"]>().toEqualTypeOf<number>();
    expectTypeOf<Payment["status"]>().toEqualTypeOf<PaymentStatus>();
    expectTypeOf<SarrafEvent["payment"]>().toEqualTypeOf<Payment>();
  });

  it("isSarrafError narrows unknown errors", () => {
    const err: unknown = new Error("x");
    if (isSarrafError(err)) expectTypeOf(err).toEqualTypeOf<SarrafError>();
  });
});
