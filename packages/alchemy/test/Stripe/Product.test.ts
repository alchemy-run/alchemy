import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import {
  GetPrices,
  GetProductsId,
  PostPrices,
  PostPricesPrice,
} from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: Stripe.providers() });

/**
 * Assert a product is no longer retrievable. Stripe answers a lookup for a
 * deleted object with an `invalid_request_error` whose `code` is
 * `resource_missing` (distilled dispatches on `error.type` before status, so
 * this is `InvalidRequestError`, not `NotFound`).
 */
const expectProductGone = (productId: string) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(GetProductsId({ id: productId }));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(["InvalidRequestError", "NotFound"]).toContain(
        result.failure._tag,
      );
    }
  });

test.provider("create and delete a product with default props", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const product = yield* stack.deploy(Stripe.Product("DefaultProduct"));

    expect(product.productId).toBeDefined();
    expect(product.productId.startsWith("prod_")).toBe(true);
    // `name` defaults to the resource's logical ID.
    expect(product.name).toEqual("DefaultProduct");
    expect(product.active).toEqual(true);
    expect(product.type).toEqual("service");
    expect(product.description).toBeUndefined();
    expect(product.images).toEqual([]);
    expect(product.marketingFeatures).toEqual([]);
    // The alchemy branding keys are stripped from the user-facing attribute.
    expect(product.metadata).toEqual({});

    const fetched = yield* GetProductsId({ id: product.productId });
    expect(fetched.id).toEqual(product.productId);
    expect(fetched.name).toEqual("DefaultProduct");
    expect(fetched.active).toEqual(true);
    // …but they are really on the object, which is how a lost state row
    // re-discovers this product.
    expect(fetched.metadata.alchemy_id).toEqual("DefaultProduct");
    expect(fetched.metadata.alchemy_stage).toBeDefined();
    expect(fetched.metadata.alchemy_stack).toBeDefined();

    yield* stack.destroy();

    // A product with no prices attached is genuinely deleted.
    yield* expectProductGone(product.productId);
  }),
);

test.provider("create a product with the full service prop surface", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const product = yield* stack.deploy(
      Stripe.Product("FullServiceProduct", {
        name: "Alchemy Test Team Plan",
        description: "Everything in Free, plus unlimited seats.",
        active: true,
        images: [
          "https://alchemy.run/logo.png",
          "https://alchemy.run/logo-dark.png",
        ],
        marketingFeatures: [
          { name: "Unlimited projects" },
          { name: "Priority support" },
        ],
        statementDescriptor: "ALCHEMY TEAM",
        unitLabel: "seat",
        url: "https://alchemy.run",
        type: "service",
        metadata: { tier: "team", channel: "direct" },
      }),
    );

    expect(product.name).toEqual("Alchemy Test Team Plan");
    expect(product.description).toEqual(
      "Everything in Free, plus unlimited seats.",
    );
    expect(product.type).toEqual("service");
    expect(product.images).toEqual([
      "https://alchemy.run/logo.png",
      "https://alchemy.run/logo-dark.png",
    ]);
    expect(product.marketingFeatures).toEqual([
      { name: "Unlimited projects" },
      { name: "Priority support" },
    ]);
    expect(product.statementDescriptor).toEqual("ALCHEMY TEAM");
    expect(product.unitLabel).toEqual("seat");
    expect(product.url).toEqual("https://alchemy.run");
    expect(product.metadata).toEqual({ tier: "team", channel: "direct" });
    expect(product.defaultPriceId).toBeUndefined();

    const fetched = yield* GetProductsId({ id: product.productId });
    expect(fetched.name).toEqual("Alchemy Test Team Plan");
    expect(fetched.unit_label).toEqual("seat");
    expect(fetched.statement_descriptor).toEqual("ALCHEMY TEAM");
    expect(fetched.url).toEqual("https://alchemy.run");
    expect(fetched.images).toEqual([
      "https://alchemy.run/logo.png",
      "https://alchemy.run/logo-dark.png",
    ]);
    expect(fetched.marketing_features).toEqual([
      { name: "Unlimited projects" },
      { name: "Priority support" },
    ]);
    expect(fetched.metadata.tier).toEqual("team");
    expect(fetched.metadata.channel).toEqual("direct");
    expect(fetched.metadata.alchemy_id).toEqual("FullServiceProduct");

    yield* stack.destroy();
    yield* expectProductGone(product.productId);
  }),
);

test.provider("update a product in place and unset removed fields", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.Product("UpdatedProduct", {
        name: "Alchemy Test Product v1",
        description: "First revision.",
        images: ["https://alchemy.run/v1.png"],
        marketingFeatures: [{ name: "Feature A" }],
        url: "https://alchemy.run/v1",
        metadata: { revision: "1", keep: "yes" },
      }),
    );

    expect(created.description).toEqual("First revision.");
    expect(created.images).toEqual(["https://alchemy.run/v1.png"]);
    expect(created.metadata).toEqual({ revision: "1", keep: "yes" });

    const updated = yield* stack.deploy(
      Stripe.Product("UpdatedProduct", {
        name: "Alchemy Test Product v2",
        // description / images / marketingFeatures / url dropped — Stripe
        // unsets them by posting an empty string.
        metadata: { keep: "yes" },
        active: false,
      }),
    );

    // Every mutable change happens in place: the Stripe object ID is stable.
    expect(updated.productId).toEqual(created.productId);
    expect(updated.name).toEqual("Alchemy Test Product v2");
    expect(updated.description).toBeUndefined();
    expect(updated.images).toEqual([]);
    expect(updated.marketingFeatures).toEqual([]);
    expect(updated.url).toBeUndefined();
    expect(updated.active).toEqual(false);
    expect(updated.metadata).toEqual({ keep: "yes" });

    const fetched = yield* GetProductsId({ id: updated.productId });
    expect(fetched.name).toEqual("Alchemy Test Product v2");
    expect(fetched.description).toBeNull();
    expect(fetched.images).toEqual([]);
    expect(fetched.marketing_features).toEqual([]);
    expect(fetched.url).toBeNull();
    expect(fetched.active).toEqual(false);
    expect(fetched.metadata.keep).toEqual("yes");
    // The removed key really is gone, not just absent from our attrs.
    expect(fetched.metadata.revision).toBeUndefined();
    // Branding survives an update.
    expect(fetched.metadata.alchemy_id).toEqual("UpdatedProduct");

    yield* stack.destroy();
    yield* expectProductGone(updated.productId);
  }),
);

test.provider("changing type replaces the product", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const service = yield* stack.deploy(
      Stripe.Product("ReplacedTypeProduct", {
        name: "Alchemy Test Replaceable",
        type: "service",
      }),
    );
    expect(service.type).toEqual("service");

    const good = yield* stack.deploy(
      Stripe.Product("ReplacedTypeProduct", {
        name: "Alchemy Test Replaceable",
        type: "good",
        shippable: true,
        packageDimensions: { height: 2, length: 6, weight: 12, width: 4 },
      }),
    );

    // `type` is immutable in Stripe, so the engine created a new object.
    expect(good.type).toEqual("good");
    expect(good.productId).not.toEqual(service.productId);
    expect(good.shippable).toEqual(true);
    expect(good.packageDimensions).toEqual({
      height: 2,
      length: 6,
      weight: 12,
      width: 4,
    });

    const fetched = yield* GetProductsId({ id: good.productId });
    expect(fetched.type).toEqual("good");
    expect(fetched.shippable).toEqual(true);
    expect(fetched.package_dimensions).toEqual({
      height: 2,
      length: 6,
      weight: 12,
      width: 4,
    });

    // The replaced generation is deleted.
    yield* expectProductGone(service.productId);

    yield* stack.destroy();
    yield* expectProductGone(good.productId);
  }),
);

test.provider("changing a pinned Stripe id replaces the product", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const first = yield* stack.deploy(
      Stripe.Product("PinnedIdProduct", {
        id: "alchemy_test_product_pinned_a",
        name: "Alchemy Test Pinned A",
      }),
    );
    expect(first.productId).toEqual("alchemy_test_product_pinned_a");

    const second = yield* stack.deploy(
      Stripe.Product("PinnedIdProduct", {
        id: "alchemy_test_product_pinned_b",
        name: "Alchemy Test Pinned B",
      }),
    );

    expect(second.productId).toEqual("alchemy_test_product_pinned_b");
    expect(second.productId).not.toEqual(first.productId);

    const fetched = yield* GetProductsId({ id: second.productId });
    expect(fetched.name).toEqual("Alchemy Test Pinned B");

    yield* expectProductGone(first.productId);

    yield* stack.destroy();
    yield* expectProductGone(second.productId);
  }),
);

test.provider(
  "deleting a product that has prices archives it instead",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const product = yield* stack.deploy(
        Stripe.Product("ArchivedProduct", {
          // Pinned so repeat runs reuse the same (undeletable) object rather
          // than accumulating archived products in the test account.
          id: "alchemy_test_product_archived",
          name: "Alchemy Test Archived Product",
        }),
      );
      expect(product.productId).toEqual("alchemy_test_product_archived");
      expect(product.active).toEqual(true);

      // Attach a price out-of-band so Stripe refuses to delete the product.
      // Prices can never be deleted, so only create one when the product
      // doesn't already have one from an earlier run.
      const prices = yield* GetPrices({ product: product.productId, limit: 1 });
      if (prices.data.length === 0) {
        yield* PostPrices({
          product: product.productId,
          currency: "usd",
          unit_amount: 1000,
        });
      }

      yield* stack.destroy();

      // The product survives, deactivated.
      const fetched = yield* GetProductsId({ id: product.productId });
      expect(fetched.id).toEqual(product.productId);
      expect(fetched.active).toEqual(false);

      // Leave the account tidy: archive the price we attached.
      const remaining = yield* GetPrices({
        product: product.productId,
        active: true,
        limit: 100,
      });
      yield* Effect.forEach(
        remaining.data,
        (price) => PostPricesPrice({ price: price.id, active: false }),
        { concurrency: 4 },
      );
    }),
);
