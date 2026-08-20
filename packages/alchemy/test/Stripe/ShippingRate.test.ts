import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetShippingRatesShippingRateToken } from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Stripe.providers() });

test.provider("create a shipping rate with minimal props", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const rate = yield* stack.deploy(
      Stripe.ShippingRate("MinimalShippingRate", {
        displayName: "Standard shipping",
        fixedAmount: { amount: 500, currency: "usd" },
      }),
    );

    expect(rate.shippingRateId).toBeDefined();
    expect(rate.shippingRateId.startsWith("shr_")).toBe(true);
    expect(rate.displayName).toEqual("Standard shipping");
    expect(rate.type).toEqual("fixed_amount");
    expect(rate.active).toEqual(true);
    expect(rate.fixedAmount?.amount).toEqual(500);
    expect(rate.fixedAmount?.currency).toEqual("usd");
    // alchemy's reserved metadata keys never leak into the attribute.
    expect(rate.metadata).toEqual({});

    const fetched = yield* GetShippingRatesShippingRateToken({
      shipping_rate_token: rate.shippingRateId,
    });
    expect(fetched.display_name).toEqual("Standard shipping");
    expect(fetched.type).toEqual("fixed_amount");
    expect(fetched.active).toEqual(true);
    expect(fetched.fixed_amount?.amount).toEqual(500);
    expect(fetched.fixed_amount?.currency).toEqual("usd");
    // Ownership branding is written to Stripe metadata.
    expect(fetched.metadata?.alchemy_id).toEqual("MinimalShippingRate");

    yield* stack.destroy();
  }),
);

test.provider("create a shipping rate with the full prop surface", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const rate = yield* stack.deploy(
      Stripe.ShippingRate("FullShippingRate", {
        displayName: "Express shipping",
        type: "fixed_amount",
        fixedAmount: {
          amount: 1500,
          currency: "usd",
          currencyOptions: {
            eur: { amount: 1400, taxBehavior: "exclusive" },
          },
        },
        deliveryEstimate: {
          minimum: { unit: "business_day", value: 1 },
          maximum: { unit: "business_day", value: 2 },
        },
        taxBehavior: "exclusive",
        taxCode: "txcd_92010001",
        active: true,
        metadata: { tier: "express", drop: "me" },
      }),
    );

    expect(rate.shippingRateId).toBeDefined();
    expect(rate.displayName).toEqual("Express shipping");
    expect(rate.taxBehavior).toEqual("exclusive");
    expect(rate.taxCode).toEqual("txcd_92010001");
    expect(rate.deliveryEstimate).toEqual({
      minimum: { unit: "business_day", value: 1 },
      maximum: { unit: "business_day", value: 2 },
    });
    expect(rate.fixedAmount?.currencyOptions?.eur?.amount).toEqual(1400);
    expect(rate.metadata).toEqual({ tier: "express", drop: "me" });

    const fetched = yield* GetShippingRatesShippingRateToken({
      shipping_rate_token: rate.shippingRateId,
    });
    expect(fetched.tax_behavior).toEqual("exclusive");
    expect(fetched.tax_code).toEqual("txcd_92010001");
    expect(fetched.delivery_estimate?.minimum).toEqual({
      unit: "business_day",
      value: 1,
    });
    expect(fetched.fixed_amount?.currency_options?.eur?.amount).toEqual(1400);

    yield* stack.destroy();
  }),
);

test.provider("update metadata and currency options in place", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.ShippingRate("UpdatableShippingRate", {
        displayName: "Updatable shipping",
        fixedAmount: {
          amount: 900,
          currency: "usd",
          currencyOptions: { eur: { amount: 850 } },
        },
        metadata: { env: "test", drop: "me" },
      }),
    );

    expect(created.fixedAmount?.currencyOptions?.eur?.amount).toEqual(850);
    expect(created.metadata).toEqual({ env: "test", drop: "me" });

    const updated = yield* stack.deploy(
      Stripe.ShippingRate("UpdatableShippingRate", {
        displayName: "Updatable shipping",
        fixedAmount: {
          amount: 900,
          currency: "usd",
          currencyOptions: {
            eur: { amount: 800 },
            gbp: { amount: 750 },
          },
        },
        metadata: { env: "test" },
      }),
    );

    // Nothing immutable changed, so the object is updated in place.
    expect(updated.shippingRateId).toEqual(created.shippingRateId);
    expect(updated.fixedAmount?.amount).toEqual(900);
    expect(updated.fixedAmount?.currencyOptions?.eur?.amount).toEqual(800);
    expect(updated.fixedAmount?.currencyOptions?.gbp?.amount).toEqual(750);
    // A metadata key the user removed is actually unset in Stripe.
    expect(updated.metadata).toEqual({ env: "test" });

    const fetched = yield* GetShippingRatesShippingRateToken({
      shipping_rate_token: updated.shippingRateId,
    });
    expect(fetched.fixed_amount?.currency_options?.eur?.amount).toEqual(800);
    expect(fetched.fixed_amount?.currency_options?.gbp?.amount).toEqual(750);
    expect(fetched.metadata?.drop).toBeUndefined();
    expect(fetched.metadata?.env).toEqual("test");

    yield* stack.destroy();
  }),
);

test.provider("tax behavior is settable once, then replaces", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    // Stripe defaults `tax_behavior` to `unspecified`.
    const created = yield* stack.deploy(
      Stripe.ShippingRate("TaxBehaviorShippingRate", {
        displayName: "Tax behavior shipping",
        fixedAmount: { amount: 700, currency: "usd" },
      }),
    );
    expect(created.taxBehavior).toEqual("unspecified");

    // `unspecified` -> `exclusive` is accepted in place.
    const settled = yield* stack.deploy(
      Stripe.ShippingRate("TaxBehaviorShippingRate", {
        displayName: "Tax behavior shipping",
        fixedAmount: { amount: 700, currency: "usd" },
        taxBehavior: "exclusive",
      }),
    );
    expect(settled.shippingRateId).toEqual(created.shippingRateId);
    expect(settled.taxBehavior).toEqual("exclusive");

    // `exclusive` -> `inclusive` is rejected by Stripe, so we replace.
    const replaced = yield* stack.deploy(
      Stripe.ShippingRate("TaxBehaviorShippingRate", {
        displayName: "Tax behavior shipping",
        fixedAmount: { amount: 700, currency: "usd" },
        taxBehavior: "inclusive",
      }),
    );
    expect(replaced.shippingRateId).not.toEqual(settled.shippingRateId);
    expect(replaced.taxBehavior).toEqual("inclusive");

    yield* stack.destroy();
  }),
);

test.provider("archive an active shipping rate in place", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.ShippingRate("ArchivableShippingRate", {
        displayName: "Archivable shipping",
        fixedAmount: { amount: 400, currency: "usd" },
      }),
    );
    expect(created.active).toEqual(true);

    const archived = yield* stack.deploy(
      Stripe.ShippingRate("ArchivableShippingRate", {
        displayName: "Archivable shipping",
        fixedAmount: { amount: 400, currency: "usd" },
        active: false,
      }),
    );

    expect(archived.shippingRateId).toEqual(created.shippingRateId);
    expect(archived.active).toEqual(false);

    const fetched = yield* GetShippingRatesShippingRateToken({
      shipping_rate_token: archived.shippingRateId,
    });
    expect(fetched.active).toEqual(false);

    yield* stack.destroy();
  }),
);

test.provider("changing the fixed amount replaces the shipping rate", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.ShippingRate("ReplacedShippingRate", {
        displayName: "Replaced shipping",
        fixedAmount: { amount: 500, currency: "usd" },
      }),
    );
    expect(created.fixedAmount?.amount).toEqual(500);

    const replaced = yield* stack.deploy(
      Stripe.ShippingRate("ReplacedShippingRate", {
        displayName: "Replaced shipping",
        fixedAmount: { amount: 650, currency: "usd" },
      }),
    );

    // `fixed_amount.amount` is immutable in Stripe — a change must produce
    // a new id.
    expect(replaced.shippingRateId).not.toEqual(created.shippingRateId);
    expect(replaced.fixedAmount?.amount).toEqual(650);

    const fetched = yield* GetShippingRatesShippingRateToken({
      shipping_rate_token: replaced.shippingRateId,
    });
    expect(fetched.fixed_amount?.amount).toEqual(650);
    // The replaced generation is archived, not deleted.
    const old = yield* GetShippingRatesShippingRateToken({
      shipping_rate_token: created.shippingRateId,
    });
    expect(old.active).toEqual(false);

    yield* stack.destroy();
  }),
);

test.provider("changing displayName replaces the shipping rate", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.ShippingRate("RenamedShippingRate", {
        displayName: "Original name",
        fixedAmount: { amount: 300, currency: "usd" },
      }),
    );

    const replaced = yield* stack.deploy(
      Stripe.ShippingRate("RenamedShippingRate", {
        displayName: "New name",
        fixedAmount: { amount: 300, currency: "usd" },
      }),
    );

    // Stripe's update endpoint does not accept `display_name`.
    expect(replaced.shippingRateId).not.toEqual(created.shippingRateId);
    expect(replaced.displayName).toEqual("New name");

    yield* stack.destroy();
  }),
);

test.provider(
  "destroy archives the shipping rate rather than deleting it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stripe.ShippingRate("DestroyedShippingRate", {
          displayName: "Destroyed shipping",
          fixedAmount: { amount: 250, currency: "usd" },
        }),
      );
      expect(created.active).toEqual(true);

      yield* stack.destroy();

      // Stripe has no delete API for shipping rates: the object survives,
      // archived.
      const fetched = yield* GetShippingRatesShippingRateToken({
        shipping_rate_token: created.shippingRateId,
      });
      expect(fetched.id).toEqual(created.shippingRateId);
      expect(fetched.active).toEqual(false);

      // Destroy is idempotent.
      yield* stack.destroy();
    }),
);
