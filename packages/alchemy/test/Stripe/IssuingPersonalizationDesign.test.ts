import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import {
  GetIssuingPersonalizationDesignsPersonalizationDesign,
  GetIssuingPhysicalBundles,
  type IssuingPhysicalBundle,
} from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Stripe.providers() });

/**
 * Issuing is an entitlement: a plain test account has no
 * `/v1/issuing/physical_bundles` and every call 403s. Gate the whole suite
 * behind an explicit opt-in so an unentitled account skips cleanly.
 */
const ISSUING = test.provider.skipIf(!process.env.STRIPE_TEST_ISSUING);

/**
 * Personalization designs can never be deleted, so every test uses a
 * deterministic lookup key and always sets `transferLookupKey` — a re-run
 * must be able to reclaim the key from the design the previous run left
 * behind rather than colliding on it.
 */
const LOOKUP_KEY_FULL = "alchemy-test-ipd-full";
const LOOKUP_KEY_UPDATE = "alchemy-test-ipd-update";

/**
 * Resolve the physical bundles usable by the test account. Honours an
 * explicit `STRIPE_TEST_PHYSICAL_BUNDLE` override, otherwise enumerates the
 * account's active bundles.
 */
const physicalBundles = Effect.gen(function* () {
  const override = yield* Effect.sync(
    () => process.env.STRIPE_TEST_PHYSICAL_BUNDLE,
  );
  const response = yield* GetIssuingPhysicalBundles({
    limit: 100,
    status: "active",
  });
  const bundles = [...response.data];
  if (!override) return bundles;
  // Keep the override first so `bundles[0]` is always the requested one.
  return [
    ...bundles.filter((bundle) => bundle.id === override),
    ...bundles.filter((bundle) => bundle.id !== override),
  ];
});

/** The first bundle, failing loudly rather than silently passing on none. */
const firstPhysicalBundle = Effect.gen(function* () {
  const bundles = yield* physicalBundles;
  const bundle = bundles[0];
  expect(bundle).toBeDefined();
  return bundle as IssuingPhysicalBundle;
});

const getDesign = (personalizationDesignId: string) =>
  GetIssuingPersonalizationDesignsPersonalizationDesign({
    personalization_design: personalizationDesignId,
  });

ISSUING("create a minimal personalization design", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const bundle = yield* firstPhysicalBundle;

    const design = yield* stack.deploy(
      Stripe.IssuingPersonalizationDesign("MinimalDesign", {
        physicalBundle: bundle.id,
      }),
    );

    expect(design.personalizationDesignId).toBeDefined();
    expect(design.personalizationDesignId.startsWith("ipd_")).toBe(true);
    expect(design.physicalBundle).toEqual(bundle.id);
    expect(design.name).toBeUndefined();
    expect(design.lookupKey).toBeUndefined();
    // Alchemy's `alchemy_*` branding is stripped from the user-facing attr.
    expect(design.metadata).toEqual({});
    expect(design.preferences.isDefault).toBe(false);
    expect(["inactive", "review", "active", "rejected"]).toContain(
      design.status,
    );

    // Out-of-band: the object really exists, and carries Alchemy's branding.
    const fetched = yield* getDesign(design.personalizationDesignId);
    expect(fetched.id).toEqual(design.personalizationDesignId);
    expect(fetched.metadata.alchemy_id).toEqual("MinimalDesign");

    yield* stack.destroy();

    // Stripe has no delete endpoint for this object — destroying the stack
    // drops the state row but the design lives on in the account.
    const afterDestroy = yield* getDesign(design.personalizationDesignId);
    expect(afterDestroy.id).toEqual(design.personalizationDesignId);
  }),
);

ISSUING("create a fully configured personalization design", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const bundles = yield* physicalBundles;
    // Carrier text is only accepted by bundles whose features allow it.
    const bundle =
      bundles.find((b) => b.features.carrier_text !== "unsupported") ??
      bundles[0];
    expect(bundle).toBeDefined();
    const supportsCarrierText = bundle!.features.carrier_text !== "unsupported";

    const carrierText = supportsCarrierText
      ? {
          headerTitle: "Welcome to Alchemy",
          headerBody: "Your card is ready to use.",
          footerTitle: "Questions?",
          footerBody: "Reach us at support@alchemy.test",
        }
      : undefined;

    const design = yield* stack.deploy(
      Stripe.IssuingPersonalizationDesign("FullDesign", {
        physicalBundle: bundle!.id,
        name: "Alchemy Full Design",
        lookupKey: LOOKUP_KEY_FULL,
        transferLookupKey: true,
        ...(carrierText !== undefined ? { carrierText } : {}),
        preferences: { isDefault: false },
        metadata: { team: "payments", env: "test" },
      }),
    );

    expect(design.name).toEqual("Alchemy Full Design");
    expect(design.lookupKey).toEqual(LOOKUP_KEY_FULL);
    expect(design.metadata).toEqual({ team: "payments", env: "test" });
    expect(design.preferences.isDefault).toBe(false);
    if (carrierText !== undefined) {
      expect(design.carrierText).toEqual(carrierText);
    }

    const fetched = yield* getDesign(design.personalizationDesignId);
    expect(fetched.name).toEqual("Alchemy Full Design");
    expect(fetched.lookup_key).toEqual(LOOKUP_KEY_FULL);
    expect(fetched.metadata.team).toEqual("payments");
    // Branding is written alongside the user's metadata, never instead of it.
    expect(fetched.metadata.alchemy_id).toEqual("FullDesign");
    if (carrierText !== undefined) {
      expect(fetched.carrier_text?.header_title).toEqual("Welcome to Alchemy");
      expect(fetched.carrier_text?.footer_body).toEqual(
        "Reach us at support@alchemy.test",
      );
    }

    yield* stack.destroy();
  }),
);

ISSUING("update a personalization design in place", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const bundle = yield* firstPhysicalBundle;

    const created = yield* stack.deploy(
      Stripe.IssuingPersonalizationDesign("UpdatableDesign", {
        physicalBundle: bundle.id,
        name: "Before",
        lookupKey: LOOKUP_KEY_UPDATE,
        transferLookupKey: true,
        metadata: { phase: "before" },
      }),
    );

    expect(created.name).toEqual("Before");
    expect(created.metadata).toEqual({ phase: "before" });

    const updated = yield* stack.deploy(
      Stripe.IssuingPersonalizationDesign("UpdatableDesign", {
        physicalBundle: bundle.id,
        name: "After",
        lookupKey: LOOKUP_KEY_UPDATE,
        transferLookupKey: true,
        metadata: { phase: "after", extra: "added" },
      }),
    );

    // Nothing on this resource is immutable — every change converges in
    // place, so the id must survive.
    expect(updated.personalizationDesignId).toEqual(
      created.personalizationDesignId,
    );
    expect(updated.name).toEqual("After");
    expect(updated.metadata).toEqual({ phase: "after", extra: "added" });

    const fetched = yield* getDesign(updated.personalizationDesignId);
    expect(fetched.name).toEqual("After");
    expect(fetched.metadata.phase).toEqual("after");
    expect(fetched.metadata.extra).toEqual("added");

    yield* stack.destroy();
  }),
);

ISSUING(
  "unsets name, lookup key and metadata when props are removed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const bundle = yield* firstPhysicalBundle;

      const created = yield* stack.deploy(
        Stripe.IssuingPersonalizationDesign("UnsetDesign", {
          physicalBundle: bundle.id,
          name: "Named",
          metadata: { drop: "me" },
        }),
      );

      expect(created.name).toEqual("Named");
      expect(created.metadata).toEqual({ drop: "me" });

      const cleared = yield* stack.deploy(
        Stripe.IssuingPersonalizationDesign("UnsetDesign", {
          physicalBundle: bundle.id,
        }),
      );

      expect(cleared.personalizationDesignId).toEqual(
        created.personalizationDesignId,
      );
      expect(cleared.name).toBeUndefined();
      expect(cleared.metadata).toEqual({});

      // Out-of-band: Stripe really stored `null` / dropped the key rather than
      // an empty string, and Alchemy's branding survived the metadata rewrite.
      const fetched = yield* getDesign(cleared.personalizationDesignId);
      expect(fetched.name).toBeNull();
      expect(fetched.metadata.drop).toBeUndefined();
      expect(fetched.metadata.alchemy_id).toEqual("UnsetDesign");

      yield* stack.destroy();
    }),
);

ISSUING("moves a design onto a different physical bundle in place", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const bundles = yield* physicalBundles;
    const first = bundles[0];
    const second = bundles[1];
    expect(first).toBeDefined();
    if (second === undefined) {
      // The account exposes a single physical bundle — nothing to move to.
      yield* Effect.logInfo(
        "skipping physical-bundle move: account has only one active bundle",
      );
      yield* stack.destroy();
      return;
    }

    const created = yield* stack.deploy(
      Stripe.IssuingPersonalizationDesign("BundleMoveDesign", {
        physicalBundle: first!.id,
      }),
    );
    expect(created.physicalBundle).toEqual(first!.id);

    const moved = yield* stack.deploy(
      Stripe.IssuingPersonalizationDesign("BundleMoveDesign", {
        physicalBundle: second.id,
      }),
    );

    // `physical_bundle` is accepted by the update endpoint, so this is an
    // in-place change rather than a replacement — critical, because a
    // replaced design could never be cleaned up.
    expect(moved.personalizationDesignId).toEqual(
      created.personalizationDesignId,
    );
    expect(moved.physicalBundle).toEqual(second.id);

    const fetched = yield* getDesign(moved.personalizationDesignId);
    const observedBundle =
      typeof fetched.physical_bundle === "string"
        ? fetched.physical_bundle
        : fetched.physical_bundle.id;
    expect(observedBundle).toEqual(second.id);

    yield* stack.destroy();
  }),
);

ISSUING("re-adopts the same design after destroy and redeploy", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const bundle = yield* firstPhysicalBundle;

    const first = yield* stack.deploy(
      Stripe.IssuingPersonalizationDesign("ReadoptDesign", {
        physicalBundle: bundle.id,
        name: "Readopt",
      }),
    );

    yield* stack.destroy();

    // The design survives the destroy (no delete API) and keeps Alchemy's
    // branding, so the next deploy of the same logical id must find and
    // adopt it instead of creating a second, permanently-undeletable design.
    const second = yield* stack.deploy(
      Stripe.IssuingPersonalizationDesign("ReadoptDesign", {
        physicalBundle: bundle.id,
        name: "Readopt",
      }),
    );

    expect(second.personalizationDesignId).toEqual(
      first.personalizationDesignId,
    );

    const fetched = yield* getDesign(second.personalizationDesignId);
    expect(fetched.id).toEqual(first.personalizationDesignId);

    yield* stack.destroy();
  }),
);
