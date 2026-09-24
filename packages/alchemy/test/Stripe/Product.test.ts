import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetProduct } from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { isMissingStripeResource } from "@/Stripe/missing.ts";

const { test } = Test.make({ providers: Stripe.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (id: string) =>
  GetProduct({ id }).pipe(
    Effect.as("found" as const),
    Effect.catchIf(isMissingStripeResource, () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a product",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.Product("CatalogProduct", {
            name: "Alchemy Catalog Product",
            description: "Initial description",
            images: ["https://example.com/product.png"],
            metadata: { tier: "pro" },
          });
        }),
      );

      expect(created.id).toMatch(/^prod_/);
      expect(created.name).toEqual("Alchemy Catalog Product");
      expect(created.description).toEqual("Initial description");
      expect(created.active).toEqual(true);
      expect(created.images).toEqual(["https://example.com/product.png"]);
      expect(created.metadata).toMatchObject({ tier: "pro" });
      expect(created.created).toEqual(expect.any(Number));
      expect(created.livemode).toEqual(false);

      const fetched = yield* GetProduct({ id: created.id });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("Initial description");
      expect(fetched.active).toEqual(true);
      expect(fetched.images).toEqual(["https://example.com/product.png"]);
      expect(fetched.metadata?.tier).toEqual("pro");
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stack],
      ).toBeDefined();
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stage],
      ).toBeDefined();
      expect(fetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.Product("CatalogProduct", {
            name: "Alchemy Catalog Product Updated",
            description: "Updated description",
            active: false,
            images: ["https://example.com/product-updated.png"],
            metadata: { tier: "enterprise", sku: "ent-1" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.name).toEqual("Alchemy Catalog Product Updated");
      expect(updated.description).toEqual("Updated description");
      expect(updated.active).toEqual(false);
      expect(updated.images).toEqual([
        "https://example.com/product-updated.png",
      ]);
      expect(updated.metadata).toEqual({ tier: "enterprise", sku: "ent-1" });

      const refetched = yield* GetProduct({ id: updated.id });
      expect(refetched.name).toEqual(updated.name);
      expect(refetched.description).toEqual("Updated description");
      expect(refetched.active).toEqual(false);
      expect(refetched.images).toEqual(updated.images);
      expect(refetched.metadata?.tier).toEqual("enterprise");
      expect(refetched.metadata?.sku).toEqual("ent-1");
      expect(refetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:stripe", "provider:stripe:product", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "list enumerates the deployed product",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.Product("ListProduct", {
            name: "Alchemy List Product",
            metadata: { kind: "list" },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.Product);
      const all = yield* provider.list();
      const found = all.find((product) => product.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.name).toEqual(deployed.name);
      expect(found?.metadata).toMatchObject({ kind: "list" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:stripe", "provider:stripe:product", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "destroy archives a product that still has prices",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const product = yield* Stripe.Product("PricedProduct", {
            name: "Alchemy Priced Product",
          });
          const price = yield* Stripe.Price("AttachedPrice", {
            product: product.id,
            currency: "usd",
            unitAmount: 1500,
          });
          return { product, price };
        }),
      );

      expect(created.product.id).toMatch(/^prod_/);
      expect(created.price.id).toMatch(/^price_/);
      expect(created.price.product).toEqual(created.product.id);

      yield* stack.destroy();

      const archived = yield* GetProduct({ id: created.product.id });
      expect(archived.id).toEqual(created.product.id);
      expect(archived.active).toEqual(false);
    }).pipe(logLevel),
  {
    tags: [
      "provider:stripe",
      "provider:stripe:price",
      "provider:stripe:product",
      "live",
    ],
    timeout: 120_000,
  },
);

test.provider(
  "create with a fixed id, tax code, and marketing features",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fixedId = `prod_alchemy_fixed_${Date.now()}`;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.Product("FixedIdProduct", {
            id: fixedId,
            name: "Alchemy Fixed Id Product",
            taxCode: "txcd_10000000",
            marketingFeatures: [{ name: "Unlimited members" }],
          });
        }),
      );

      expect(created.id).toEqual(fixedId);
      expect(created.taxCode).toEqual("txcd_10000000");
      expect(created.marketingFeatures).toEqual([
        { name: "Unlimited members" },
      ]);

      const fetched = yield* GetProduct({ id: fixedId });
      expect(fetched.id).toEqual(fixedId);
      expect(fetched.marketing_features).toEqual([
        { name: "Unlimited members" },
      ]);

      // Tax code and marketing features are mutable, so the id is kept.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.Product("FixedIdProduct", {
            id: fixedId,
            name: "Alchemy Fixed Id Product",
            taxCode: "txcd_20030000",
            marketingFeatures: [
              { name: "Unlimited members" },
              { name: "Priority support" },
            ],
          });
        }),
      );

      expect(updated.id).toEqual(fixedId);
      expect(updated.taxCode).toEqual("txcd_20030000");
      expect(updated.marketingFeatures).toEqual([
        { name: "Unlimited members" },
        { name: "Priority support" },
      ]);

      // An empty list clears them.
      const cleared = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.Product("FixedIdProduct", {
            id: fixedId,
            name: "Alchemy Fixed Id Product",
            taxCode: "txcd_20030000",
            marketingFeatures: [],
          });
        }),
      );

      expect(cleared.marketingFeatures).toEqual([]);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(fixedId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replace the product when the fixed id changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const firstId = `prod_alchemy_first_${Date.now()}`;
      const secondId = `prod_alchemy_second_${Date.now()}`;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.Product("MovedIdProduct", {
            id: firstId,
            name: "Alchemy Moved Id Product",
          });
        }),
      );

      expect(created.id).toEqual(firstId);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.Product("MovedIdProduct", {
            id: secondId,
            name: "Alchemy Moved Id Product",
          });
        }),
      );

      expect(replaced.id).toEqual(secondId);

      const oldGone = yield* waitUntilGone(firstId);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(secondId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
