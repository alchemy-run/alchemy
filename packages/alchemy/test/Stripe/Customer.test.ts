import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import {
  DeleteTestHelpersTestClocksTestClock,
  GetCustomersCustomer,
  PostTestHelpersTestClocks,
} from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Stripe.providers() });

/**
 * Fixed point in time for the test clock used by the replacement case. A
 * constant (never `Date.now()`) so repeated runs are identical.
 * 2026-08-01T00:00:00Z.
 */
const FROZEN_TIME = 1_785_542_400;

/**
 * `invoice_prefix` must be unique across the whole Stripe account, so the
 * two values the update case flips between are namespaced to this suite.
 */
const INVOICE_PREFIX_A = "ALCHCUSTA";
const INVOICE_PREFIX_B = "ALCHCUSTB";

/** Retrieve a customer out-of-band, mapping the soft-delete tombstone. */
const fetchCustomer = Effect.fn(function* (customerId: string) {
  const response = yield* GetCustomersCustomer({ customer: customerId });
  return "deleted" in response ? undefined : response;
});

test.provider("create, update and delete a customer", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.Customer("BasicCustomer", {
        email: "basic@alchemy-test.example",
        name: "Basic Customer",
      }),
    );

    expect(created.customerId).toMatch(/^cus_/);
    expect(created.email).toEqual("basic@alchemy-test.example");
    expect(created.name).toEqual("Basic Customer");
    expect(created.description).toBeUndefined();
    expect(created.taxExempt).toEqual("none");
    expect(created.balance).toEqual(0);
    // Alchemy's reserved keys never leak into the user-facing attribute.
    expect(created.metadata).toEqual({});

    const fetched = yield* fetchCustomer(created.customerId);
    expect(fetched?.email).toEqual("basic@alchemy-test.example");
    expect(fetched?.name).toEqual("Basic Customer");
    // ...but they ARE written to Stripe, which is how state-loss recovery
    // and adoption gating work.
    expect(fetched?.metadata?.alchemy_id).toEqual("BasicCustomer");
    expect(fetched?.metadata?.alchemy_stack).toBeDefined();
    expect(fetched?.metadata?.alchemy_stage).toBeDefined();

    // In-place update: everything except `testClock` is mutable, so the id
    // must survive.
    const updated = yield* stack.deploy(
      Stripe.Customer("BasicCustomer", {
        email: "basic+updated@alchemy-test.example",
        name: "Basic Customer (renamed)",
        description: "Now with a description",
        phone: "+15555550123",
        metadata: { tier: "starter" },
      }),
    );

    expect(updated.customerId).toEqual(created.customerId);
    expect(updated.email).toEqual("basic+updated@alchemy-test.example");
    expect(updated.name).toEqual("Basic Customer (renamed)");
    expect(updated.description).toEqual("Now with a description");
    expect(updated.phone).toEqual("+15555550123");
    expect(updated.metadata).toEqual({ tier: "starter" });

    const refetched = yield* fetchCustomer(updated.customerId);
    expect(refetched?.email).toEqual("basic+updated@alchemy-test.example");
    expect(refetched?.description).toEqual("Now with a description");
    expect(refetched?.metadata?.tier).toEqual("starter");
    expect(refetched?.metadata?.alchemy_id).toEqual("BasicCustomer");

    // Dropping a previously-set scalar unsets it in Stripe.
    const cleared = yield* stack.deploy(
      Stripe.Customer("BasicCustomer", {
        email: "basic+updated@alchemy-test.example",
        name: "Basic Customer (renamed)",
      }),
    );
    expect(cleared.customerId).toEqual(created.customerId);
    expect(cleared.description).toBeUndefined();
    expect(cleared.phone).toBeUndefined();
    expect(cleared.metadata).toEqual({});

    const afterClear = yield* fetchCustomer(cleared.customerId);
    expect(afterClear?.description).toBeNull();
    expect(afterClear?.phone).toBeNull();
    expect(afterClear?.metadata?.tier).toBeUndefined();

    yield* stack.destroy();

    // Stripe soft-deletes: the id still resolves, but the body is a
    // tombstone. `fetchCustomer` maps that to `undefined`, exactly as the
    // provider's `read` does.
    const afterDelete = yield* GetCustomersCustomer({
      customer: created.customerId,
    });
    expect("deleted" in afterDelete).toBe(true);
    expect(yield* fetchCustomer(created.customerId)).toBeUndefined();

    yield* stack.destroy();
  }),
);

test.provider(
  "create a customer with the full prop surface",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const customer = yield* stack.deploy(
        Stripe.Customer("FullCustomer", {
          email: "full@alchemy-test.example",
          name: "Full Customer",
          description: "Every supported property",
          phone: "+15555550199",
          address: {
            line1: "1 Market St",
            line2: "Suite 400",
            city: "San Francisco",
            state: "CA",
            postalCode: "94105",
            country: "US",
          },
          shipping: {
            name: "Full Customer Receiving",
            phone: "+15555550188",
            address: {
              line1: "500 Dock St",
              city: "Oakland",
              state: "CA",
              postalCode: "94607",
              country: "US",
            },
          },
          balance: -5000,
          invoicePrefix: INVOICE_PREFIX_A,
          invoiceSettings: {
            footer: "Thanks for your business!",
            customFields: [{ name: "PO Number", value: "PO-1234" }],
            renderingOptions: { amountTaxDisplay: "exclude_tax" },
          },
          nextInvoiceSequence: 42,
          preferredLocales: ["en-US"],
          taxExempt: "reverse",
          metadata: { tier: "enterprise", region: "us" },
        }),
      );

      expect(customer.customerId).toMatch(/^cus_/);
      expect(customer.address).toEqual({
        line1: "1 Market St",
        line2: "Suite 400",
        city: "San Francisco",
        state: "CA",
        postalCode: "94105",
        country: "US",
      });
      expect(customer.shipping?.name).toEqual("Full Customer Receiving");
      expect(customer.shipping?.address.city).toEqual("Oakland");
      expect(customer.balance).toEqual(-5000);
      expect(customer.invoicePrefix).toEqual(INVOICE_PREFIX_A);
      expect(customer.invoiceSettings?.footer).toEqual(
        "Thanks for your business!",
      );
      expect(customer.invoiceSettings?.customFields).toEqual([
        { name: "PO Number", value: "PO-1234" },
      ]);
      expect(
        customer.invoiceSettings?.renderingOptions?.amountTaxDisplay,
      ).toEqual("exclude_tax");
      expect(customer.preferredLocales).toEqual(["en-US"]);
      expect(customer.taxExempt).toEqual("reverse");
      expect(customer.livemode).toBe(false);
      expect(customer.metadata).toEqual({ tier: "enterprise", region: "us" });

      const fetched = yield* fetchCustomer(customer.customerId);
      expect(fetched?.address?.line1).toEqual("1 Market St");
      expect(fetched?.shipping?.address?.city).toEqual("Oakland");
      expect(fetched?.balance).toEqual(-5000);
      expect(fetched?.invoice_prefix).toEqual(INVOICE_PREFIX_A);
      expect(fetched?.invoice_settings?.footer).toEqual(
        "Thanks for your business!",
      );
      expect(fetched?.tax_exempt).toEqual("reverse");
      expect(fetched?.preferred_locales).toEqual(["en-US"]);

      // A second deploy of the identical props must be a no-op: the provider
      // diffs desired against OBSERVED state, so nothing is re-posted and the
      // attributes come back unchanged.
      const unchanged = yield* stack.deploy(
        Stripe.Customer("FullCustomer", {
          email: "full@alchemy-test.example",
          name: "Full Customer",
          description: "Every supported property",
          phone: "+15555550199",
          address: {
            line1: "1 Market St",
            line2: "Suite 400",
            city: "San Francisco",
            state: "CA",
            postalCode: "94105",
            country: "US",
          },
          shipping: {
            name: "Full Customer Receiving",
            phone: "+15555550188",
            address: {
              line1: "500 Dock St",
              city: "Oakland",
              state: "CA",
              postalCode: "94607",
              country: "US",
            },
          },
          balance: -5000,
          invoicePrefix: INVOICE_PREFIX_A,
          invoiceSettings: {
            footer: "Thanks for your business!",
            customFields: [{ name: "PO Number", value: "PO-1234" }],
            renderingOptions: { amountTaxDisplay: "exclude_tax" },
          },
          nextInvoiceSequence: 42,
          preferredLocales: ["en-US"],
          taxExempt: "reverse",
          metadata: { tier: "enterprise", region: "us" },
        }),
      );
      expect(unchanged.customerId).toEqual(customer.customerId);
      expect(unchanged.invoicePrefix).toEqual(INVOICE_PREFIX_A);

      // Mutating the nested/structured props keeps the same customer.
      const mutated = yield* stack.deploy(
        Stripe.Customer("FullCustomer", {
          email: "full@alchemy-test.example",
          name: "Full Customer",
          address: {
            line1: "2 Market St",
            city: "San Francisco",
            country: "US",
          },
          invoicePrefix: INVOICE_PREFIX_B,
          invoiceSettings: { footer: "Updated footer" },
          taxExempt: "exempt",
          metadata: { tier: "enterprise" },
        }),
      );

      expect(mutated.customerId).toEqual(customer.customerId);
      expect(mutated.address).toEqual({
        line1: "2 Market St",
        city: "San Francisco",
        country: "US",
      });
      expect(mutated.invoicePrefix).toEqual(INVOICE_PREFIX_B);
      expect(mutated.invoiceSettings?.footer).toEqual("Updated footer");
      expect(mutated.invoiceSettings?.customFields).toBeUndefined();
      expect(mutated.taxExempt).toEqual("exempt");
      // Shipping dropped from props is unset in Stripe.
      expect(mutated.shipping).toBeUndefined();
      expect(mutated.metadata).toEqual({ tier: "enterprise" });

      const afterMutate = yield* fetchCustomer(mutated.customerId);
      expect(afterMutate?.address?.line1).toEqual("2 Market St");
      expect(afterMutate?.address?.line2).toBeNull();
      expect(afterMutate?.shipping).toBeNull();
      expect(afterMutate?.invoice_prefix).toEqual(INVOICE_PREFIX_B);
      expect(afterMutate?.invoice_settings?.custom_fields).toBeNull();
      expect(afterMutate?.tax_exempt).toEqual("exempt");
      expect(afterMutate?.metadata?.region).toBeUndefined();

      yield* stack.destroy();

      expect(yield* fetchCustomer(customer.customerId)).toBeUndefined();

      yield* stack.destroy();
    }),
  { timeout: 180_000 },
);

test.provider(
  "replace the customer when its test clock changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const clock = yield* PostTestHelpersTestClocks({
        frozen_time: FROZEN_TIME,
        name: "alchemy-customer-replacement",
      });

      const before = yield* stack.deploy(
        Stripe.Customer("ClockedCustomer", {
          email: "clocked@alchemy-test.example",
        }),
      );
      expect(before.testClock).toBeUndefined();

      // `test_clock` is create-only in Stripe's API — a customer can never be
      // moved between clocks — so the provider must replace rather than update.
      const after = yield* stack.deploy(
        Stripe.Customer("ClockedCustomer", {
          email: "clocked@alchemy-test.example",
          testClock: clock.id,
        }),
      );

      expect(after.customerId).not.toEqual(before.customerId);
      expect(after.testClock).toEqual(clock.id);

      const fetched = yield* fetchCustomer(after.customerId);
      expect(fetched?.test_clock).toBeDefined();

      // The replaced generation was deleted.
      expect(yield* fetchCustomer(before.customerId)).toBeUndefined();

      yield* stack.destroy();

      expect(yield* fetchCustomer(after.customerId)).toBeUndefined();

      yield* DeleteTestHelpersTestClocksTestClock({
        test_clock: clock.id,
      }).pipe(Effect.ignore);

      yield* stack.destroy();
    }),
  { timeout: 180_000 },
);
