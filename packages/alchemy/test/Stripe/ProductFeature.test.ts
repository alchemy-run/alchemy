import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import {
  GetProductsProductFeatures,
  GetProductsProductFeaturesId,
  PostProductsProductFeatures,
} from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Stripe.providers() });

/**
 * Feature lookup keys are permanently reserved by Stripe (archiving does not
 * release them), so every key here is a deterministic constant reused across
 * runs.
 */
const FEATURE_A_KEY = "alchemy_test_product_feature_a";
const FEATURE_B_KEY = "alchemy_test_product_feature_b";

/**
 * A `product_feature` is gone once either the attachment or its parent
 * product no longer exists — both surface as a missing resource.
 */
const attachmentState = (productId: string, productFeatureId: string) =>
  GetProductsProductFeaturesId({
    product: productId,
    id: productFeatureId,
  }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("InvalidRequestError", (error) =>
      error.code === "resource_missing"
        ? Effect.succeed("gone" as const)
        : Effect.fail(error),
    ),
  );

test.provider("attaches a feature to a product then detaches it", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        const product = yield* Stripe.Product("AttachProduct", {
          name: "Alchemy Test Attach Product",
        });
        const feature = yield* Stripe.Feature("AttachFeature", {
          lookupKey: FEATURE_A_KEY,
          name: "Attach Feature A",
        });
        const attachment = yield* Stripe.ProductFeature("Attachment", {
          productId: product.productId,
          entitlementFeatureId: feature.featureId,
        });
        return { product, feature, attachment };
      }),
    );

    expect(deployed.attachment.productFeatureId).toBeDefined();
    expect(deployed.attachment.productId).toEqual(deployed.product.productId);
    expect(deployed.attachment.entitlementFeatureId).toEqual(
      deployed.feature.featureId,
    );
    expect(deployed.attachment.featureLookupKey).toEqual(FEATURE_A_KEY);
    expect(deployed.attachment.featureName).toEqual("Attach Feature A");
    expect(deployed.attachment.livemode).toBe(false);

    const fetched = yield* GetProductsProductFeaturesId({
      product: deployed.product.productId,
      id: deployed.attachment.productFeatureId,
    });
    expect(fetched.id).toEqual(deployed.attachment.productFeatureId);
    expect(fetched.entitlement_feature.id).toEqual(deployed.feature.featureId);
    expect(fetched.entitlement_feature.lookup_key).toEqual(FEATURE_A_KEY);

    yield* stack.destroy();

    expect(
      yield* attachmentState(
        deployed.product.productId,
        deployed.attachment.productFeatureId,
      ),
    ).toEqual("gone");
  }),
);

test.provider("redeploying the same attachment is a no-op", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const program = Effect.gen(function* () {
      const product = yield* Stripe.Product("NoopProduct", {
        name: "Alchemy Test Noop Product",
      });
      const feature = yield* Stripe.Feature("NoopFeature", {
        lookupKey: FEATURE_A_KEY,
        name: "Attach Feature A",
      });
      const attachment = yield* Stripe.ProductFeature("NoopAttachment", {
        productId: product.productId,
        entitlementFeatureId: feature.featureId,
      });
      return { product, feature, attachment };
    });

    const created = yield* stack.deploy(program);
    const again = yield* stack.deploy(program);

    expect(again.attachment.productFeatureId).toEqual(
      created.attachment.productFeatureId,
    );
    expect(again.attachment.productId).toEqual(created.attachment.productId);

    // Exactly one attachment on the product — a second create would have
    // produced a duplicate row.
    const listed = yield* GetProductsProductFeatures({
      product: created.product.productId,
      limit: 100,
    });
    expect(
      listed.data.filter(
        (row) => row.entitlement_feature.id === created.feature.featureId,
      ).length,
    ).toEqual(1);

    yield* stack.destroy();
  }),
);

test.provider("replaces the attachment when the feature changes", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        const product = yield* Stripe.Product("ReplaceProduct", {
          name: "Alchemy Test Replace Product",
        });
        const featureA = yield* Stripe.Feature("ReplaceFeatureA", {
          lookupKey: FEATURE_A_KEY,
          name: "Attach Feature A",
        });
        const featureB = yield* Stripe.Feature("ReplaceFeatureB", {
          lookupKey: FEATURE_B_KEY,
          name: "Attach Feature B",
        });
        const attachment = yield* Stripe.ProductFeature("ReplaceAttachment", {
          productId: product.productId,
          entitlementFeatureId: featureA.featureId,
        });
        return { product, featureA, featureB, attachment };
      }),
    );
    expect(initial.attachment.entitlementFeatureId).toEqual(
      initial.featureA.featureId,
    );

    const replaced = yield* stack.deploy(
      Effect.gen(function* () {
        const product = yield* Stripe.Product("ReplaceProduct", {
          name: "Alchemy Test Replace Product",
        });
        const featureA = yield* Stripe.Feature("ReplaceFeatureA", {
          lookupKey: FEATURE_A_KEY,
          name: "Attach Feature A",
        });
        const featureB = yield* Stripe.Feature("ReplaceFeatureB", {
          lookupKey: FEATURE_B_KEY,
          name: "Attach Feature B",
        });
        const attachment = yield* Stripe.ProductFeature("ReplaceAttachment", {
          productId: product.productId,
          entitlementFeatureId: featureB.featureId,
        });
        return { product, featureA, featureB, attachment };
      }),
    );

    expect(replaced.attachment.entitlementFeatureId).toEqual(
      replaced.featureB.featureId,
    );
    expect(replaced.attachment.productFeatureId).not.toEqual(
      initial.attachment.productFeatureId,
    );
    expect(replaced.attachment.featureLookupKey).toEqual(FEATURE_B_KEY);

    const fetched = yield* GetProductsProductFeaturesId({
      product: replaced.product.productId,
      id: replaced.attachment.productFeatureId,
    });
    expect(fetched.entitlement_feature.id).toEqual(replaced.featureB.featureId);

    // The old generation was detached.
    expect(
      yield* attachmentState(
        initial.product.productId,
        initial.attachment.productFeatureId,
      ),
    ).toEqual("gone");

    yield* stack.destroy();
  }),
);

test.provider("adopts an attachment that already exists out of band", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const parents = yield* stack.deploy(
      Effect.gen(function* () {
        const product = yield* Stripe.Product("AdoptProduct", {
          name: "Alchemy Test Adopt Product",
        });
        const feature = yield* Stripe.Feature("AdoptFeature", {
          lookupKey: FEATURE_A_KEY,
          name: "Attach Feature A",
        });
        return { product, feature };
      }),
    );

    // Attach out of band — the engine has never seen this attachment.
    const outOfBand = yield* PostProductsProductFeatures({
      product: parents.product.productId,
      entitlement_feature: parents.feature.featureId,
    });

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        const product = yield* Stripe.Product("AdoptProduct", {
          name: "Alchemy Test Adopt Product",
        });
        const feature = yield* Stripe.Feature("AdoptFeature", {
          lookupKey: FEATURE_A_KEY,
          name: "Attach Feature A",
        });
        const attachment = yield* Stripe.ProductFeature("AdoptAttachment", {
          productId: product.productId,
          entitlementFeatureId: feature.featureId,
        });
        return { product, feature, attachment };
      }),
    );

    // The (product, feature) pair is the identity, so reconcile adopts the
    // existing attachment instead of creating a duplicate.
    expect(deployed.attachment.productFeatureId).toEqual(outOfBand.id);

    const listed = yield* GetProductsProductFeatures({
      product: parents.product.productId,
      limit: 100,
    });
    expect(
      listed.data.filter(
        (row) => row.entitlement_feature.id === parents.feature.featureId,
      ).length,
    ).toEqual(1);

    yield* stack.destroy();

    expect(
      yield* attachmentState(parents.product.productId, outOfBand.id),
    ).toEqual("gone");
  }),
);
