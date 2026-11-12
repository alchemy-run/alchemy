import { randomBytes } from "node:crypto";
import * as Stripe from "@alchemy.run/stripe";
import { isMissingStripeResource } from "@alchemy.run/stripe/missing";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import {
  CreateTestHelpersTestClock,
  DeleteTestHelpersTestClock,
  GetCustomer,
} from "@distilled.cloud/stripe/stripe";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Stripe.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const waitUntilGone = (id: string) =>
  GetCustomer({ customer: id }).pipe(
    Effect.map((customer) =>
      "deleted" in customer && customer.deleted ? ("gone" as const) : ("found" as const),
    ),
    Effect.catchIf(isMissingStripeResource, () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a customer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.Customer("CatalogCustomer", {
            email: "alchemy.catalog.customer@example.com",
            name: "Alchemy Catalog Customer",
            description: "Initial description",
            phone: "+15555550100",
            metadata: { plan: "pro" },
          });
        }),
      );
      yield* expectFound(Stripe.Customer.lookup({ id: created.id }), created);

      expect(created.id).toMatch(/^cus_/);
      expect(created.email).toEqual("alchemy.catalog.customer@example.com");
      expect(created.name).toEqual("Alchemy Catalog Customer");
      expect(created.description).toEqual("Initial description");
      expect(created.phone).toEqual("+15555550100");
      expect(created.metadata).toMatchObject({ plan: "pro" });
      expect(created.created).toEqual(expect.any(Number));
      expect(created.livemode).toEqual(false);

      const fetched = yield* GetCustomer({ customer: created.id });
      if (!("email" in fetched)) {
        return;
      }
      expect(fetched.id).toEqual(created.id);
      expect(fetched.email).toEqual(created.email);
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("Initial description");
      expect(fetched.phone).toEqual("+15555550100");
      expect(fetched.metadata?.plan).toEqual("pro");
      expect(fetched.metadata?.[Stripe.alchemyMetadataKeys.stack]).toBeDefined();
      expect(fetched.metadata?.[Stripe.alchemyMetadataKeys.stage]).toBeDefined();
      expect(fetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.Customer("CatalogCustomer", {
            email: "alchemy.catalog.customer.updated@example.com",
            name: "Alchemy Catalog Customer Updated",
            description: "Updated description",
            phone: "+15555550199",
            metadata: { plan: "enterprise", sku: "ent-1" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.email).toEqual("alchemy.catalog.customer.updated@example.com");
      expect(updated.name).toEqual("Alchemy Catalog Customer Updated");
      expect(updated.description).toEqual("Updated description");
      expect(updated.phone).toEqual("+15555550199");
      expect(updated.metadata).toEqual({ plan: "enterprise", sku: "ent-1" });

      const refetched = yield* GetCustomer({ customer: updated.id });
      if (!("email" in refetched)) {
        return;
      }
      expect(refetched.email).toEqual(updated.email);
      expect(refetched.name).toEqual(updated.name);
      expect(refetched.description).toEqual("Updated description");
      expect(refetched.phone).toEqual("+15555550199");
      expect(refetched.metadata?.plan).toEqual("enterprise");
      expect(refetched.metadata?.sku).toEqual("ent-1");
      expect(refetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:stripe", "provider:stripe:customer", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "list enumerates the deployed customer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.Customer("ListCustomer", {
            email: "alchemy.list.customer@example.com",
            name: "Alchemy List Customer",
            metadata: { kind: "list" },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.Customer);
      const all = yield* provider.list();
      const found = all.find((customer) => customer.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.email).toEqual(deployed.email);
      expect(found?.name).toEqual(deployed.name);
      expect(found?.metadata).toMatchObject({ kind: "list" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:stripe", "provider:stripe:customer", "live"],
    timeout: 120_000,
  },
);

/**
 * Invoice prefixes are unique across the Stripe account, and a deleted
 * customer keeps its prefix reserved, so every run needs fresh ones (3–12
 * uppercase letters or digits). They are property values, not resources:
 * nothing leaks.
 */
const invoicePrefix = (letter: string) =>
  Effect.sync(() => `${letter}${randomBytes(4).toString("hex").slice(0, 7).toUpperCase()}`);

const address = {
  line1: "123 Main Street",
  city: "San Francisco",
  state: "CA",
  postalCode: "94111",
  country: "US",
};

test.provider(
  "set, change, and clear a customer's billing, shipping, tax, and invoice settings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const firstPrefix = yield* invoicePrefix("A");
      const secondPrefix = yield* invoicePrefix("B");

      const deployCustomer = (props: Partial<Stripe.CustomerProps>) =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Stripe.Customer("BillingCustomer", {
              email: "alchemy.billing.customer@example.com",
              ...props,
            });
          }),
        );

      const created = yield* deployCustomer({
        address,
        shipping: { name: "Alchemy Receiving", address, phone: "+15555550102" },
        businessName: "Alchemy Inc",
        individualName: "Ada Alchemy",
        preferredLocales: ["en", "fr"],
        taxExempt: "reverse",
        invoicePrefix: firstPrefix,
        nextInvoiceSequence: 10,
        invoiceSettings: {
          footer: "Thanks for your business",
          customFields: [{ name: "PO", value: "1234" }],
          renderingOptions: { amountTaxDisplay: "include_inclusive_tax" },
        },
        cashBalanceReconciliationMode: "manual",
      });
      expect(created.address).toEqual(address);
      expect(created.shipping).toEqual({
        name: "Alchemy Receiving",
        address,
        phone: "+15555550102",
      });
      expect(created.businessName).toEqual("Alchemy Inc");
      expect(created.individualName).toEqual("Ada Alchemy");
      expect(created.preferredLocales).toEqual(["en", "fr"]);
      expect(created.taxExempt).toEqual("reverse");
      expect(created.invoicePrefix).toEqual(firstPrefix);
      expect(created.nextInvoiceSequence).toEqual(10);
      expect(created.invoiceSettings).toEqual({
        footer: "Thanks for your business",
        customFields: [{ name: "PO", value: "1234" }],
        renderingOptions: { amountTaxDisplay: "include_inclusive_tax" },
      });
      expect(created.cashBalanceReconciliationMode).toEqual("manual");

      const fetched = yield* GetCustomer({ customer: created.id, expand: ["cash_balance"] });
      const live = "deleted" in fetched ? undefined : fetched;
      expect(live?.address?.postal_code).toEqual("94111");
      expect(live?.tax_exempt).toEqual("reverse");
      expect(live?.invoice_settings?.footer).toEqual("Thanks for your business");
      expect(live?.cash_balance?.settings.reconciliation_mode).toEqual("manual");

      const changed = yield* deployCustomer({
        address: { ...address, line2: "Suite 5" },
        businessName: "Alchemy Labs",
        preferredLocales: ["de"],
        taxExempt: "exempt",
        invoicePrefix: secondPrefix,
        nextInvoiceSequence: 20,
        invoiceSettings: { footer: "Net 30" },
        cashBalanceReconciliationMode: "automatic",
      });
      expect(changed.id).toEqual(created.id);
      expect(changed.address).toEqual({ ...address, line2: "Suite 5" });
      expect(changed.shipping).toBeUndefined();
      expect(changed.businessName).toEqual("Alchemy Labs");
      expect(changed.individualName).toBeUndefined();
      expect(changed.preferredLocales).toEqual(["de"]);
      expect(changed.taxExempt).toEqual("exempt");
      expect(changed.invoicePrefix).toEqual(secondPrefix);
      expect(changed.nextInvoiceSequence).toEqual(20);
      expect(changed.invoiceSettings).toEqual({ footer: "Net 30" });
      expect(changed.cashBalanceReconciliationMode).toEqual("automatic");

      const cleared = yield* deployCustomer({ nextInvoiceSequence: 15 });
      expect(cleared.id).toEqual(created.id);
      expect(cleared.address).toBeUndefined();
      expect(cleared.businessName).toBeUndefined();
      expect(cleared.preferredLocales).toEqual([]);
      expect(cleared.taxExempt).toEqual("none");
      expect(cleared.invoicePrefix).toEqual(secondPrefix);
      expect(cleared.nextInvoiceSequence).toEqual(20);
      expect(cleared.invoiceSettings).toBeUndefined();

      yield* stack.destroy();

      expect(yield* waitUntilGone(created.id)).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:stripe", "provider:stripe:customer", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "attach a customer to a test clock and replace it when the clock changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const frozenTime = 1_800_000_000;
      const first = yield* CreateTestHelpersTestClock({ frozen_time: frozenTime });
      const second = yield* CreateTestHelpersTestClock({ frozen_time: frozenTime });

      const deployCustomer = (testClock: string) =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Stripe.Customer("ClockCustomer", {
              email: "alchemy.clock.customer@example.com",
              testClock,
            });
          }),
        );

      const created = yield* deployCustomer(first.id);
      expect(created.testClock).toEqual(first.id);

      const unchanged = yield* deployCustomer(first.id);
      expect(unchanged.id).toEqual(created.id);

      const replaced = yield* deployCustomer(second.id);
      expect(replaced.id).not.toEqual(created.id);
      expect(replaced.testClock).toEqual(second.id);
      expect(yield* waitUntilGone(created.id)).toEqual("gone");

      yield* stack.destroy();

      expect(yield* waitUntilGone(replaced.id)).toEqual("gone");
      yield* DeleteTestHelpersTestClock({ test_clock: first.id });
      yield* DeleteTestHelpersTestClock({ test_clock: second.id });
    }).pipe(logLevel),
  {
    tags: ["provider:stripe", "provider:stripe:customer", "live"],
    timeout: 120_000,
  },
);
