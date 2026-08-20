import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetTaxRatesTaxRate } from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Stripe.providers() });

test.provider("create a tax rate with minimal props", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const rate = yield* stack.deploy(
      Stripe.TaxRate("MinimalTaxRate", {
        displayName: "Minimal Tax",
        percentage: 7.25,
        inclusive: false,
      }),
    );

    expect(rate.taxRateId).toBeDefined();
    expect(rate.taxRateId.startsWith("txr_")).toBe(true);
    expect(rate.displayName).toEqual("Minimal Tax");
    expect(rate.percentage).toEqual(7.25);
    expect(rate.inclusive).toEqual(false);
    expect(rate.active).toEqual(true);
    // alchemy's reserved metadata keys never leak into the attribute.
    expect(rate.metadata).toEqual({});

    const fetched = yield* GetTaxRatesTaxRate({ tax_rate: rate.taxRateId });
    expect(fetched.display_name).toEqual("Minimal Tax");
    expect(fetched.percentage).toEqual(7.25);
    expect(fetched.inclusive).toEqual(false);
    expect(fetched.active).toEqual(true);
    // Ownership branding is written to Stripe metadata.
    expect(fetched.metadata?.alchemy_id).toEqual("MinimalTaxRate");

    yield* stack.destroy();
  }),
);

test.provider("create a tax rate with the full prop surface", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const rate = yield* stack.deploy(
      Stripe.TaxRate("FullTaxRate", {
        displayName: "UK VAT",
        percentage: 20,
        inclusive: true,
        country: "GB",
        jurisdiction: "United Kingdom",
        description: "UK standard rate VAT",
        taxType: "vat",
        active: true,
        metadata: { region: "emea", tier: "standard" },
      }),
    );

    expect(rate.taxRateId).toBeDefined();
    expect(rate.displayName).toEqual("UK VAT");
    expect(rate.percentage).toEqual(20);
    expect(rate.inclusive).toEqual(true);
    expect(rate.country).toEqual("GB");
    expect(rate.jurisdiction).toEqual("United Kingdom");
    expect(rate.description).toEqual("UK standard rate VAT");
    expect(rate.taxType).toEqual("vat");
    expect(rate.metadata).toEqual({ region: "emea", tier: "standard" });

    const fetched = yield* GetTaxRatesTaxRate({ tax_rate: rate.taxRateId });
    expect(fetched.country).toEqual("GB");
    expect(fetched.jurisdiction).toEqual("United Kingdom");
    expect(fetched.description).toEqual("UK standard rate VAT");
    expect(fetched.tax_type).toEqual("vat");
    expect(fetched.inclusive).toEqual(true);
    expect(fetched.metadata?.region).toEqual("emea");

    yield* stack.destroy();
  }),
);

test.provider("update mutable fields in place", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.TaxRate("UpdatableTaxRate", {
        displayName: "Sales Tax",
        percentage: 8.5,
        inclusive: false,
        country: "US",
        state: "NY",
        description: "initial description",
        metadata: { env: "test", drop: "me" },
      }),
    );

    expect(created.displayName).toEqual("Sales Tax");
    expect(created.metadata).toEqual({ env: "test", drop: "me" });

    const updated = yield* stack.deploy(
      Stripe.TaxRate("UpdatableTaxRate", {
        displayName: "State Sales Tax",
        percentage: 8.5,
        inclusive: false,
        country: "US",
        state: "NY",
        description: "updated description",
        jurisdiction: "New York",
        taxType: "sales_tax",
        metadata: { env: "test" },
      }),
    );

    // Nothing immutable changed, so the object is updated in place.
    expect(updated.taxRateId).toEqual(created.taxRateId);
    expect(updated.displayName).toEqual("State Sales Tax");
    expect(updated.description).toEqual("updated description");
    expect(updated.jurisdiction).toEqual("New York");
    expect(updated.taxType).toEqual("sales_tax");
    // A metadata key the user removed is actually unset in Stripe.
    expect(updated.metadata).toEqual({ env: "test" });

    const fetched = yield* GetTaxRatesTaxRate({ tax_rate: updated.taxRateId });
    expect(fetched.display_name).toEqual("State Sales Tax");
    expect(fetched.description).toEqual("updated description");
    expect(fetched.jurisdiction).toEqual("New York");
    expect(fetched.tax_type).toEqual("sales_tax");
    expect(fetched.metadata?.drop).toBeUndefined();
    expect(fetched.metadata?.env).toEqual("test");

    yield* stack.destroy();
  }),
);

test.provider("archive an active tax rate in place", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.TaxRate("ArchivableTaxRate", {
        displayName: "Temporary Tax",
        percentage: 5,
        inclusive: false,
      }),
    );
    expect(created.active).toEqual(true);

    const archived = yield* stack.deploy(
      Stripe.TaxRate("ArchivableTaxRate", {
        displayName: "Temporary Tax",
        percentage: 5,
        inclusive: false,
        active: false,
      }),
    );

    expect(archived.taxRateId).toEqual(created.taxRateId);
    expect(archived.active).toEqual(false);

    const fetched = yield* GetTaxRatesTaxRate({ tax_rate: archived.taxRateId });
    expect(fetched.active).toEqual(false);

    yield* stack.destroy();
  }),
);

test.provider("changing percentage replaces the tax rate", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.TaxRate("ReplacedTaxRate", {
        displayName: "Replaced Tax",
        percentage: 10,
        inclusive: false,
      }),
    );
    expect(created.percentage).toEqual(10);

    const replaced = yield* stack.deploy(
      Stripe.TaxRate("ReplacedTaxRate", {
        displayName: "Replaced Tax",
        percentage: 12,
        inclusive: false,
      }),
    );

    // `percentage` is immutable in Stripe — a change must produce a new id.
    expect(replaced.taxRateId).not.toEqual(created.taxRateId);
    expect(replaced.percentage).toEqual(12);

    const fetched = yield* GetTaxRatesTaxRate({ tax_rate: replaced.taxRateId });
    expect(fetched.percentage).toEqual(12);
    // The replaced generation is archived, not deleted.
    const old = yield* GetTaxRatesTaxRate({ tax_rate: created.taxRateId });
    expect(old.active).toEqual(false);

    yield* stack.destroy();
  }),
);

test.provider("changing inclusive replaces the tax rate", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.TaxRate("InclusiveTaxRate", {
        displayName: "Inclusive Flip Tax",
        percentage: 15,
        inclusive: false,
      }),
    );
    expect(created.inclusive).toEqual(false);

    const replaced = yield* stack.deploy(
      Stripe.TaxRate("InclusiveTaxRate", {
        displayName: "Inclusive Flip Tax",
        percentage: 15,
        inclusive: true,
      }),
    );

    expect(replaced.taxRateId).not.toEqual(created.taxRateId);
    expect(replaced.inclusive).toEqual(true);

    yield* stack.destroy();
  }),
);

test.provider(
  "destroy archives the tax rate rather than deleting it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stripe.TaxRate("DestroyedTaxRate", {
          displayName: "Destroyed Tax",
          percentage: 3,
          inclusive: false,
        }),
      );
      expect(created.active).toEqual(true);

      yield* stack.destroy();

      // Stripe has no delete API for tax rates: the object survives, archived.
      const fetched = yield* GetTaxRatesTaxRate({
        tax_rate: created.taxRateId,
      });
      expect(fetched.id).toEqual(created.taxRateId);
      expect(fetched.active).toEqual(false);

      // Destroy is idempotent.
      yield* stack.destroy();
    }),
);
