import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetIssuingCardholdersCardholder } from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Stripe.providers() });

/**
 * Issuing is an entitlement — a plain Stripe test account cannot create
 * cardholders until Issuing is enabled on it. Set `STRIPE_TEST_ISSUING=1` on
 * an entitled account to run the full lifecycle.
 */
const issuing = test.provider.skipIf(!process.env.STRIPE_TEST_ISSUING);

/**
 * Every value below is deliberately synthetic: the `555-01xx` phone range and
 * the `203.0.113.0/24` (TEST-NET-3) address block are both reserved for
 * documentation, and the postal address is a well-known placeholder. Never
 * put realistic personal data in a test that talks to a live API.
 */
const BILLING = {
  address: {
    line1: "123 Fake Street",
    city: "San Francisco",
    state: "CA",
    postalCode: "94103",
    country: "US",
  },
} as const;

issuing(
  "create a cardholder with the minimum props and deactivate it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const cardholder = yield* stack.deploy(
        Stripe.IssuingCardholder("MinimalCardholder", {
          name: "Alchemy Test Holder",
          billing: BILLING,
        }),
      );

      expect(cardholder.cardholderId).toBeDefined();
      expect(cardholder.cardholderId.startsWith("ich_")).toBe(true);
      expect(cardholder.name).toEqual("Alchemy Test Holder");
      expect(cardholder.status).toEqual("active");
      expect(cardholder.billingAddress.postalCode).toEqual("94103");
      // Alchemy's reserved branding keys never leak into the user-facing attr.
      expect(cardholder.metadata).toEqual({});

      const fetched = yield* GetIssuingCardholdersCardholder({
        cardholder: cardholder.cardholderId,
      });
      expect(fetched.id).toEqual(cardholder.cardholderId);
      expect(fetched.billing.address.city).toEqual("San Francisco");
      // The object IS branded out of band, even though the attr hides it.
      expect(fetched.metadata.alchemy_id).toEqual("MinimalCardholder");

      yield* stack.destroy();

      // Stripe cannot delete a cardholder — destroy deactivates it and the
      // object stays retrievable forever.
      const afterDestroy = yield* GetIssuingCardholdersCardholder({
        cardholder: cardholder.cardholderId,
      });
      expect(afterDestroy.id).toEqual(cardholder.cardholderId);
      expect(afterDestroy.status).toEqual("inactive");
    }),
  { timeout: 120_000 },
);

issuing(
  "create a fully configured company cardholder",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const cardholder = yield* stack.deploy(
        Stripe.IssuingCardholder("FullCardholder", {
          name: "Alchemy Test Company",
          type: "company",
          email: "issuing-cardholder@example.com",
          phoneNumber: "+15555550100",
          company: { taxId: "000000000" },
          preferredLocales: ["en"],
          status: "active",
          billing: {
            address: {
              line1: "500 Placeholder Ave",
              line2: "Floor 4",
              city: "San Francisco",
              state: "CA",
              postalCode: "94105",
              country: "US",
            },
          },
          spendingControls: {
            allowedCategories: ["computer_software_stores"],
            spendingLimits: [{ amount: 500_000, interval: "monthly" }],
            spendingLimitsCurrency: "usd",
          },
          metadata: { team: "platform" },
        }),
      );

      expect(cardholder.type).toEqual("company");
      expect(cardholder.email).toEqual("issuing-cardholder@example.com");
      expect(cardholder.phoneNumber).toEqual("+15555550100");
      expect(cardholder.companyTaxIdProvided).toBe(true);
      expect(cardholder.preferredLocales).toEqual(["en"]);
      expect(cardholder.metadata).toEqual({ team: "platform" });
      expect(cardholder.spendingControls?.spendingLimits).toEqual([
        { amount: 500_000, interval: "monthly" },
      ]);
      expect(cardholder.billingAddress.line2).toEqual("Floor 4");

      const fetched = yield* GetIssuingCardholdersCardholder({
        cardholder: cardholder.cardholderId,
      });
      expect(fetched.type).toEqual("company");
      expect(fetched.spending_controls?.spending_limits_currency).toEqual(
        "usd",
      );
      expect(fetched.metadata.team).toEqual("platform");

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

issuing(
  "update a cardholder in place without changing its id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stripe.IssuingCardholder("MutableCardholder", {
          name: "Alchemy Test Mutable",
          email: "before@example.com",
          status: "active",
          billing: BILLING,
          metadata: { phase: "before" },
        }),
      );

      expect(created.email).toEqual("before@example.com");
      expect(created.status).toEqual("active");

      const updated = yield* stack.deploy(
        Stripe.IssuingCardholder("MutableCardholder", {
          name: "Alchemy Test Mutable",
          email: "after@example.com",
          phoneNumber: "+15555550101",
          status: "inactive",
          billing: BILLING,
          spendingControls: {
            spendingLimits: [{ amount: 25_000, interval: "daily" }],
          },
          metadata: { phase: "after" },
        }),
      );

      // Every changed field is mutable, so the cardholder is patched in place.
      expect(updated.cardholderId).toEqual(created.cardholderId);
      expect(updated.email).toEqual("after@example.com");
      expect(updated.phoneNumber).toEqual("+15555550101");
      expect(updated.status).toEqual("inactive");
      expect(updated.metadata).toEqual({ phase: "after" });

      const fetched = yield* GetIssuingCardholdersCardholder({
        cardholder: updated.cardholderId,
      });
      expect(fetched.email).toEqual("after@example.com");
      expect(fetched.status).toEqual("inactive");
      // `metadataUpdate` blanks keys the user removed rather than leaving
      // them behind, and alchemy's branding survives the patch.
      expect(fetched.metadata.phase).toEqual("after");
      expect(fetched.metadata.alchemy_id).toEqual("MutableCardholder");

      yield* stack.destroy();
    }),
  { timeout: 180_000 },
);

issuing(
  "replace the cardholder when an immutable prop changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Stripe's update endpoint accepts neither `name` nor `type`, so both
      // force a replacement.
      const created = yield* stack.deploy(
        Stripe.IssuingCardholder("ReplacedCardholder", {
          name: "Alchemy Test Original",
          billing: BILLING,
        }),
      );

      const replaced = yield* stack.deploy(
        Stripe.IssuingCardholder("ReplacedCardholder", {
          name: "Alchemy Test Renamed",
          billing: BILLING,
        }),
      );

      expect(replaced.cardholderId).not.toEqual(created.cardholderId);
      expect(replaced.name).toEqual("Alchemy Test Renamed");

      // The replaced generation is deactivated, not deleted.
      const old = yield* GetIssuingCardholdersCardholder({
        cardholder: created.cardholderId,
      });
      expect(old.status).toEqual("inactive");
      expect(old.name).toEqual("Alchemy Test Original");

      const current = yield* GetIssuingCardholdersCardholder({
        cardholder: replaced.cardholderId,
      });
      expect(current.name).toEqual("Alchemy Test Renamed");
      expect(current.status).toEqual("active");

      yield* stack.destroy();
    }),
  { timeout: 180_000 },
);

issuing(
  "deactivating twice is idempotent",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const cardholder = yield* stack.deploy(
        Stripe.IssuingCardholder("IdempotentCardholder", {
          name: "Alchemy Test Idempotent",
          billing: BILLING,
        }),
      );

      yield* stack.destroy();
      // Re-running destroy must be a safe no-op rather than an error.
      yield* stack.destroy();

      const fetched = yield* GetIssuingCardholdersCardholder({
        cardholder: cardholder.cardholderId,
      });
      expect(fetched.status).toEqual("inactive");
    }),
  { timeout: 120_000 },
);
