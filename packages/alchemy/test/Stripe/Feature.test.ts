import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetEntitlementsFeaturesId } from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Stripe.providers() });

/**
 * Stripe permanently reserves a feature's lookup key — even after the feature
 * is archived — so every lookup key here is a deterministic constant that the
 * suite reuses across runs. A run that ends by archiving is re-activated by
 * the next run's reconcile, which is exactly the behaviour we want covered.
 */
const BASIC_KEY = "alchemy_test_feature_basic";
const FULL_KEY = "alchemy_test_feature_full";
const LIFECYCLE_KEY = "alchemy_test_feature_lifecycle";
const REPLACE_BEFORE_KEY = "alchemy_test_feature_replace_before";
const REPLACE_AFTER_KEY = "alchemy_test_feature_replace_after";
const LIST_KEY = "alchemy_test_feature_list";

test.provider("create a feature with minimal props", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const feature = yield* stack.deploy(
      Stripe.Feature("BasicFeature", {
        lookupKey: BASIC_KEY,
        name: "Basic Feature",
      }),
    );

    expect(feature.featureId).toBeDefined();
    expect(feature.featureId.startsWith("feat_")).toBe(true);
    expect(feature.lookupKey).toEqual(BASIC_KEY);
    expect(feature.name).toEqual("Basic Feature");
    expect(feature.active).toBe(true);
    // The reserved `alchemy_*` keys never leak into the user-facing attribute.
    expect(feature.metadata).toEqual({});

    const fetched = yield* GetEntitlementsFeaturesId({ id: feature.featureId });
    expect(fetched.lookup_key).toEqual(BASIC_KEY);
    expect(fetched.name).toEqual("Basic Feature");
    expect(fetched.active).toBe(true);
    // …but they are written to Stripe, which is how a state-less `read`
    // re-discovers the feature.
    expect(fetched.metadata.alchemy_id).toEqual("BasicFeature");
    expect(fetched.metadata.alchemy_stack).toBeDefined();
    expect(fetched.metadata.alchemy_stage).toBeDefined();

    yield* stack.destroy();
  }),
);

test.provider("create a feature with the full prop surface", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const feature = yield* stack.deploy(
      Stripe.Feature("FullFeature", {
        lookupKey: FULL_KEY,
        name: "Full Feature",
        active: true,
        metadata: { tier: "pro", rate_limit: "10000" },
      }),
    );

    expect(feature.lookupKey).toEqual(FULL_KEY);
    expect(feature.active).toBe(true);
    expect(feature.livemode).toBe(false);
    expect(feature.metadata).toEqual({ tier: "pro", rate_limit: "10000" });

    const fetched = yield* GetEntitlementsFeaturesId({ id: feature.featureId });
    expect(fetched.metadata.tier).toEqual("pro");
    expect(fetched.metadata.rate_limit).toEqual("10000");
    expect(fetched.metadata.alchemy_id).toEqual("FullFeature");

    yield* stack.destroy();
  }),
);

test.provider(
  "updates name, active and metadata in place, then archives on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stripe.Feature("LifecycleFeature", {
          lookupKey: LIFECYCLE_KEY,
          name: "Lifecycle Feature",
          metadata: { keep: "yes", drop: "soon" },
        }),
      );
      expect(created.name).toEqual("Lifecycle Feature");
      expect(created.metadata).toEqual({ keep: "yes", drop: "soon" });

      // In-place update: same lookup key ⇒ same feature id.
      const updated = yield* stack.deploy(
        Stripe.Feature("LifecycleFeature", {
          lookupKey: LIFECYCLE_KEY,
          name: "Lifecycle Feature (renamed)",
          metadata: { keep: "yes", added: "now" },
        }),
      );
      expect(updated.featureId).toEqual(created.featureId);
      expect(updated.name).toEqual("Lifecycle Feature (renamed)");
      // `drop` was removed from the desired map, so it must be unset in
      // Stripe rather than silently left behind.
      expect(updated.metadata).toEqual({ keep: "yes", added: "now" });

      const afterUpdate = yield* GetEntitlementsFeaturesId({
        id: created.featureId,
      });
      expect(afterUpdate.name).toEqual("Lifecycle Feature (renamed)");
      expect(afterUpdate.metadata.added).toEqual("now");
      expect(afterUpdate.metadata.drop).toBeUndefined();

      // Explicitly archiving through the `active` prop is an in-place update.
      const archived = yield* stack.deploy(
        Stripe.Feature("LifecycleFeature", {
          lookupKey: LIFECYCLE_KEY,
          name: "Lifecycle Feature (renamed)",
          active: false,
          metadata: { keep: "yes", added: "now" },
        }),
      );
      expect(archived.featureId).toEqual(created.featureId);
      expect(archived.active).toBe(false);

      // …and re-activating it is too — the archived feature is rediscovered
      // by its (permanently reserved) lookup key.
      const reactivated = yield* stack.deploy(
        Stripe.Feature("LifecycleFeature", {
          lookupKey: LIFECYCLE_KEY,
          name: "Lifecycle Feature (renamed)",
          active: true,
          metadata: { keep: "yes", added: "now" },
        }),
      );
      expect(reactivated.featureId).toEqual(created.featureId);
      expect(reactivated.active).toBe(true);

      yield* stack.destroy();

      // Stripe cannot delete features: destroy archives instead, and the
      // object stays retrievable.
      const afterDestroy = yield* GetEntitlementsFeaturesId({
        id: created.featureId,
      });
      expect(afterDestroy.id).toEqual(created.featureId);
      expect(afterDestroy.active).toBe(false);
    }),
);

test.provider("replaces the feature when the lookup key changes", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Stripe.Feature("ReplaceFeature", {
        lookupKey: REPLACE_BEFORE_KEY,
        name: "Replace Feature",
      }),
    );
    expect(initial.lookupKey).toEqual(REPLACE_BEFORE_KEY);

    const replaced = yield* stack.deploy(
      Stripe.Feature("ReplaceFeature", {
        lookupKey: REPLACE_AFTER_KEY,
        name: "Replace Feature",
      }),
    );

    expect(replaced.lookupKey).toEqual(REPLACE_AFTER_KEY);
    expect(replaced.featureId).not.toEqual(initial.featureId);
    expect(replaced.active).toBe(true);

    const fetchedNew = yield* GetEntitlementsFeaturesId({
      id: replaced.featureId,
    });
    expect(fetchedNew.lookup_key).toEqual(REPLACE_AFTER_KEY);
    expect(fetchedNew.active).toBe(true);

    // The replaced generation is archived, not deleted.
    const fetchedOld = yield* GetEntitlementsFeaturesId({
      id: initial.featureId,
    });
    expect(fetchedOld.active).toBe(false);

    yield* stack.destroy();
  }),
);

test.provider("list enumerates the deployed feature", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Stripe.Feature("ListFeature", {
        lookupKey: LIST_KEY,
        name: "List Feature",
      }),
    );

    const provider = yield* Provider.findProvider(Stripe.Feature);
    const all = yield* provider.list();

    const found = all.find((f) => f.featureId === deployed.featureId);
    expect(found).toBeDefined();
    expect(found!.lookupKey).toEqual(LIST_KEY);

    yield* stack.destroy();

    // `list` must include archived features too — they still exist and still
    // hold their lookup key.
    const afterDestroy = yield* provider.list();
    const stillListed = afterDestroy.find(
      (f) => f.featureId === deployed.featureId,
    );
    expect(stillListed).toBeDefined();
    expect(stillListed!.active).toBe(false);
  }),
);
