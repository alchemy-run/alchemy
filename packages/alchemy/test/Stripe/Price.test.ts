import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetPricesPrice } from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Stripe.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Deterministic lookup keys — a lookup key is unique per account, so every
// suite gets its own constant (never Date.now / random) and every price that
// claims one also sets `transferLookupKey` so a leftover archived price from
// an interrupted run can't wedge the suite.
const FULL_LOOKUP_KEY = "alchemy-test-price-full";
const TRANSFERRED_LOOKUP_KEY = "alchemy-test-price-transferred";

test.provider(
  "create, update in place, and archive a one-time price",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const product = yield* Stripe.Product("MinimalPriceProduct", {
            name: "Alchemy Price Test Product",
          });
          const price = yield* Stripe.Price("MinimalPrice", {
            productId: product.productId,
            currency: "usd",
            unitAmount: 2000,
          });
          return { product, price };
        }),
      );

      expect(created.price.priceId).toBeDefined();
      expect(created.price.priceId.startsWith("price_")).toBe(true);
      expect(created.price.productId).toEqual(created.product.productId);
      expect(created.price.currency).toEqual("usd");
      expect(created.price.unitAmount).toEqual(2000);
      expect(created.price.active).toBe(true);
      expect(created.price.priceType).toEqual("one_time");
      expect(created.price.billingScheme).toEqual("per_unit");
      expect(created.price.recurring).toBeUndefined();
      // Alchemy's reserved branding never leaks into the user-facing attribute.
      expect(created.price.metadata).toEqual({});

      // Out-of-band: the price really exists, and carries the ownership brand.
      const fetched = yield* GetPricesPrice({ price: created.price.priceId });
      expect(fetched.id).toEqual(created.price.priceId);
      expect(fetched.unit_amount).toEqual(2000);
      expect(fetched.active).toBe(true);
      expect(fetched.metadata.alchemy_id).toBeDefined();
      expect(fetched.metadata.alchemy_stack).toBeDefined();
      expect(fetched.metadata.alchemy_stage).toBeDefined();

      // In-place update: nickname + metadata are mutable, so the ID must survive.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const product = yield* Stripe.Product("MinimalPriceProduct", {
            name: "Alchemy Price Test Product",
          });
          const price = yield* Stripe.Price("MinimalPrice", {
            productId: product.productId,
            currency: "usd",
            unitAmount: 2000,
            nickname: "Standard one-time",
            metadata: { tier: "standard" },
          });
          return { product, price };
        }),
      );

      expect(updated.price.priceId).toEqual(created.price.priceId);
      expect(updated.price.nickname).toEqual("Standard one-time");
      expect(updated.price.metadata).toEqual({ tier: "standard" });

      const afterUpdate = yield* GetPricesPrice({
        price: updated.price.priceId,
      });
      expect(afterUpdate.nickname).toEqual("Standard one-time");
      expect(afterUpdate.metadata.tier).toEqual("standard");

      // Removing a user metadata key must actually unset it in Stripe (Alchemy
      // blanks removed keys rather than leaving them behind).
      const cleared = yield* stack.deploy(
        Effect.gen(function* () {
          const product = yield* Stripe.Product("MinimalPriceProduct", {
            name: "Alchemy Price Test Product",
          });
          const price = yield* Stripe.Price("MinimalPrice", {
            productId: product.productId,
            currency: "usd",
            unitAmount: 2000,
          });
          return { product, price };
        }),
      );

      expect(cleared.price.priceId).toEqual(created.price.priceId);
      expect(cleared.price.metadata).toEqual({});
      expect(cleared.price.nickname).toBeUndefined();

      const afterClear = yield* GetPricesPrice({
        price: cleared.price.priceId,
      });
      expect(afterClear.metadata.tier).toBeUndefined();
      expect(afterClear.nickname).toBeNull();

      yield* stack.destroy();

      // Prices cannot be deleted — destroy archives them, so the object is
      // still fetchable and merely inactive.
      const archived = yield* GetPricesPrice({ price: created.price.priceId });
      expect(archived.id).toEqual(created.price.priceId);
      expect(archived.active).toBe(false);

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider("create a recurring price with the full prop surface", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        const product = yield* Stripe.Product("FullPriceProduct", {
          name: "Alchemy Full Price Test Product",
        });
        const price = yield* Stripe.Price("FullPrice", {
          productId: product.productId,
          currency: "usd",
          unitAmount: 5400,
          recurring: {
            interval: "month",
            intervalCount: 3,
            usageType: "licensed",
            trialPeriodDays: 14,
          },
          nickname: "Pro quarterly",
          lookupKey: FULL_LOOKUP_KEY,
          transferLookupKey: true,
          currencyOptions: {
            eur: { unitAmount: 4900 },
            gbp: { unitAmount: 4200 },
          },
          metadata: { plan: "pro", cadence: "quarterly" },
        });
        return { product, price };
      }),
    );

    expect(deployed.price.priceId).toBeDefined();
    expect(deployed.price.priceType).toEqual("recurring");
    expect(deployed.price.recurring).toMatchObject({
      interval: "month",
      intervalCount: 3,
      usageType: "licensed",
      trialPeriodDays: 14,
    });
    expect(deployed.price.nickname).toEqual("Pro quarterly");
    expect(deployed.price.lookupKey).toEqual(FULL_LOOKUP_KEY);
    expect(deployed.price.metadata).toEqual({
      plan: "pro",
      cadence: "quarterly",
    });

    expect(deployed.price.currencyOptions?.eur?.unitAmount).toEqual(4900);
    expect(deployed.price.currencyOptions?.gbp?.unitAmount).toEqual(4200);

    // `currency_options` is an expandable field — Stripe omits it unless it is
    // asked for by name.
    const fetched = yield* GetPricesPrice({
      price: deployed.price.priceId,
      expand: ["currency_options"],
    });
    expect(fetched.recurring?.interval).toEqual("month");
    expect(fetched.recurring?.interval_count).toEqual(3);
    expect(fetched.recurring?.trial_period_days).toEqual(14);
    expect(fetched.lookup_key).toEqual(FULL_LOOKUP_KEY);
    expect(fetched.currency_options?.eur?.unit_amount).toEqual(4900);
    expect(fetched.currency_options?.gbp?.unit_amount).toEqual(4200);

    // `taxBehavior` is settable exactly once: unspecified -> exclusive is an
    // in-place update, so the price ID must survive it.
    const taxed = yield* stack.deploy(
      Effect.gen(function* () {
        const product = yield* Stripe.Product("FullPriceProduct", {
          name: "Alchemy Full Price Test Product",
        });
        const price = yield* Stripe.Price("FullPrice", {
          productId: product.productId,
          currency: "usd",
          unitAmount: 5400,
          recurring: {
            interval: "month",
            intervalCount: 3,
            usageType: "licensed",
            trialPeriodDays: 14,
          },
          nickname: "Pro quarterly",
          lookupKey: FULL_LOOKUP_KEY,
          transferLookupKey: true,
          taxBehavior: "exclusive",
          currencyOptions: {
            eur: { unitAmount: 4900 },
            gbp: { unitAmount: 4200 },
          },
          metadata: { plan: "pro", cadence: "quarterly" },
        });
        return { product, price };
      }),
    );

    expect(taxed.price.priceId).toEqual(deployed.price.priceId);
    expect(taxed.price.taxBehavior).toEqual("exclusive");

    const afterTax = yield* GetPricesPrice({ price: taxed.price.priceId });
    expect(afterTax.tax_behavior).toEqual("exclusive");

    yield* stack.destroy();

    const archived = yield* GetPricesPrice({ price: deployed.price.priceId });
    expect(archived.active).toBe(false);

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("create a graduated tiered price", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        const product = yield* Stripe.Product("TieredPriceProduct", {
          name: "Alchemy Tiered Price Test Product",
        });
        const price = yield* Stripe.Price("TieredPrice", {
          productId: product.productId,
          currency: "usd",
          // `billingScheme` is inferred as "tiered" from `tiers`.
          tiersMode: "graduated",
          tiers: [
            { upTo: 1000, unitAmount: 0 },
            { upTo: "inf", unitAmount: 1 },
          ],
          recurring: { interval: "month" },
        });
        return { product, price };
      }),
    );

    expect(deployed.price.billingScheme).toEqual("tiered");
    expect(deployed.price.tiersMode).toEqual("graduated");
    expect(deployed.price.unitAmount).toBeUndefined();
    expect(deployed.price.tiers).toHaveLength(2);
    expect(deployed.price.tiers?.[0]).toMatchObject({
      upTo: 1000,
      unitAmount: 0,
    });
    // Stripe encodes the open-ended fallback tier as a null upper bound.
    expect(deployed.price.tiers?.[1]).toMatchObject({
      upTo: "inf",
      unitAmount: 1,
    });

    const fetched = yield* GetPricesPrice({
      price: deployed.price.priceId,
      expand: ["tiers"],
    });
    expect(fetched.billing_scheme).toEqual("tiered");
    expect(fetched.tiers_mode).toEqual("graduated");
    expect(fetched.tiers).toHaveLength(2);
    expect(fetched.tiers?.[1]?.up_to).toBeNull();

    yield* stack.destroy();

    const archived = yield* GetPricesPrice({ price: deployed.price.priceId });
    expect(archived.active).toBe(false);

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("replaces the price when an immutable field changes", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const original = yield* stack.deploy(
      Effect.gen(function* () {
        const product = yield* Stripe.Product("ReplacePriceProduct", {
          name: "Alchemy Replace Price Test Product",
        });
        const price = yield* Stripe.Price("ReplacePrice", {
          productId: product.productId,
          currency: "usd",
          unitAmount: 2000,
          recurring: { interval: "month" },
          lookupKey: TRANSFERRED_LOOKUP_KEY,
          transferLookupKey: true,
        });
        return { product, price };
      }),
    );

    expect(original.price.unitAmount).toEqual(2000);
    expect(original.price.lookupKey).toEqual(TRANSFERRED_LOOKUP_KEY);

    // `unitAmount` is immutable — Stripe has no way to reprice an existing
    // price, so Alchemy must create a new one and archive the old.
    const replaced = yield* stack.deploy(
      Effect.gen(function* () {
        const product = yield* Stripe.Product("ReplacePriceProduct", {
          name: "Alchemy Replace Price Test Product",
        });
        const price = yield* Stripe.Price("ReplacePrice", {
          productId: product.productId,
          currency: "usd",
          unitAmount: 2500,
          recurring: { interval: "month" },
          lookupKey: TRANSFERRED_LOOKUP_KEY,
          transferLookupKey: true,
        });
        return { product, price };
      }),
    );

    expect(replaced.price.priceId).not.toEqual(original.price.priceId);
    expect(replaced.price.unitAmount).toEqual(2500);
    // The lookup key moved to the replacement, so application code that
    // resolves the price by key keeps working.
    expect(replaced.price.lookupKey).toEqual(TRANSFERRED_LOOKUP_KEY);

    const newPrice = yield* GetPricesPrice({ price: replaced.price.priceId });
    expect(newPrice.unit_amount).toEqual(2500);
    expect(newPrice.active).toBe(true);
    expect(newPrice.lookup_key).toEqual(TRANSFERRED_LOOKUP_KEY);

    // The superseded price is archived, not deleted, and no longer owns the key.
    const oldPrice = yield* GetPricesPrice({ price: original.price.priceId });
    expect(oldPrice.id).toEqual(original.price.priceId);
    expect(oldPrice.active).toBe(false);
    expect(oldPrice.lookup_key).toBeNull();

    yield* stack.destroy();

    const archived = yield* GetPricesPrice({ price: replaced.price.priceId });
    expect(archived.active).toBe(false);

    yield* stack.destroy();
  }).pipe(logLevel),
);

// Canonical `list()` test (account collection): `GET /v1/prices` is paginated
// with `starting_after`, and every row is hydrated into the exact `read`
// Attributes shape so `alchemy unsafe nuke` can act on it directly.
test.provider("list enumerates the deployed price", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        const product = yield* Stripe.Product("ListPriceProduct", {
          name: "Alchemy List Price Test Product",
        });
        const price = yield* Stripe.Price("ListPrice", {
          productId: product.productId,
          currency: "usd",
          unitAmount: 1500,
          recurring: { interval: "year" },
        });
        return { product, price };
      }),
    );

    const provider = yield* Provider.findProvider(Stripe.Price);
    const all = yield* provider.list();

    const found = all.find((p) => p.priceId === deployed.price.priceId);
    expect(found).toBeDefined();
    expect(found?.productId).toEqual(deployed.product.productId);
    expect(found?.unitAmount).toEqual(1500);
    expect(found?.priceType).toEqual("recurring");
    expect(found?.recurring?.interval).toEqual("year");

    yield* stack.destroy();
  }).pipe(logLevel),
);
