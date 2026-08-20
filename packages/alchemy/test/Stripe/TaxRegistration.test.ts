import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetTaxRegistrationsId } from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Stripe.providers() });

/**
 * Tax registrations are **permanent, account-level records**: Stripe has no
 * delete API, so every lifecycle run leaves an expired registration on the
 * account forever. They also require Stripe Tax to be enabled. The mutating
 * suite is therefore gated behind an explicit opt-in; the read-only `list`
 * case below runs unconditionally and doubles as the "is Stripe Tax on?"
 * probe.
 */
const LIVE = process.env.STRIPE_TEST_TAX_REGISTRATIONS === "1";

test.provider("list enumerates tax registrations", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const provider = yield* Provider.findProvider(Stripe.TaxRegistration);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);
    for (const registration of all) {
      expect(registration.taxRegistrationId).toBeDefined();
      expect(registration.country).toBeDefined();
      expect(typeof registration.activeFrom).toEqual("number");
    }

    yield* stack.destroy();
  }),
);

test.provider.skipIf(!LIVE)(
  "create and expire a US state sales tax registration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const registration = yield* stack.deploy(
        Stripe.TaxRegistration("MinimalRegistration", {
          country: "US",
          countryOptions: { us: { state: "AK", type: "state_sales_tax" } },
        }),
      );

      expect(registration.taxRegistrationId).toBeDefined();
      expect(registration.country).toEqual("US");
      expect(registration.status).toEqual("active");
      expect(registration.expiresAt).toBeUndefined();
      expect(typeof registration.activeFrom).toEqual("number");

      const fetched = yield* GetTaxRegistrationsId({
        id: registration.taxRegistrationId,
      });
      expect(fetched.id).toEqual(registration.taxRegistrationId);
      expect(fetched.country).toEqual("US");
      expect(fetched.status).toEqual("active");

      yield* stack.destroy();

      // Stripe cannot delete a registration — destroy expires it, and the
      // record stays on the account forever.
      const expired = yield* GetTaxRegistrationsId({
        id: registration.taxRegistrationId,
      });
      expect(expired.id).toEqual(registration.taxRegistrationId);
      expect(expired.status).toEqual("expired");
      expect(expired.expires_at).not.toBeNull();

      yield* stack.destroy();
    }),
);

test.provider.skipIf(!LIVE)(
  "create a scheduled registration with the full prop surface",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Fixed timestamps so the test is deterministic across runs.
      const activeFrom = 1_798_761_600; // 2027-01-01T00:00:00Z
      const expiresAt = 1_830_297_600; // 2028-01-01T00:00:00Z

      const registration = yield* stack.deploy(
        Stripe.TaxRegistration("ScheduledRegistration", {
          country: "DE",
          countryOptions: { de: { type: "standard" } },
          activeFrom,
          expiresAt,
        }),
      );

      expect(registration.country).toEqual("DE");
      expect(registration.activeFrom).toEqual(activeFrom);
      expect(registration.expiresAt).toEqual(expiresAt);
      expect(registration.status).toEqual("scheduled");

      const fetched = yield* GetTaxRegistrationsId({
        id: registration.taxRegistrationId,
      });
      expect(fetched.active_from).toEqual(activeFrom);
      expect(fetched.expires_at).toEqual(expiresAt);

      yield* stack.destroy();

      // A scheduled registration is expired by pulling `active_from`
      // forward as well as setting `expires_at`.
      const expired = yield* GetTaxRegistrationsId({
        id: registration.taxRegistrationId,
      });
      expect(expired.status).toEqual("expired");

      yield* stack.destroy();
    }),
);

test.provider.skipIf(!LIVE)("update expiresAt in place", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const expiresAt = 1_830_297_600; // 2028-01-01T00:00:00Z

    const created = yield* stack.deploy(
      Stripe.TaxRegistration("UpdateRegistration", {
        country: "US",
        countryOptions: { us: { state: "WY", type: "state_sales_tax" } },
      }),
    );
    expect(created.expiresAt).toBeUndefined();

    const updated = yield* stack.deploy(
      Stripe.TaxRegistration("UpdateRegistration", {
        country: "US",
        countryOptions: { us: { state: "WY", type: "state_sales_tax" } },
        expiresAt,
      }),
    );

    // In-place update: the id and the start date must survive.
    expect(updated.taxRegistrationId).toEqual(created.taxRegistrationId);
    expect(updated.activeFrom).toEqual(created.activeFrom);
    expect(updated.expiresAt).toEqual(expiresAt);

    const fetched = yield* GetTaxRegistrationsId({
      id: updated.taxRegistrationId,
    });
    expect(fetched.expires_at).toEqual(expiresAt);

    yield* stack.destroy();
  }),
);

test.provider.skipIf(!LIVE)(
  "re-deploying identical props is a no-op",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = stack.deploy(
        Stripe.TaxRegistration("NoopRegistration", {
          country: "US",
          countryOptions: { us: { state: "MT", type: "state_sales_tax" } },
        }),
      );

      const created = yield* deploy;
      const again = yield* deploy;

      expect(again.taxRegistrationId).toEqual(created.taxRegistrationId);
      // `activeFrom` defaults to "now"; a no-op deploy must not re-date it.
      expect(again.activeFrom).toEqual(created.activeFrom);
      expect(again.expiresAt).toBeUndefined();

      yield* stack.destroy();
    }),
);

test.provider.skipIf(!LIVE)(
  "changing countryOptions replaces the registration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stripe.TaxRegistration("ReplaceRegistration", {
          country: "US",
          countryOptions: { us: { state: "NV", type: "state_sales_tax" } },
        }),
      );

      const replaced = yield* stack.deploy(
        Stripe.TaxRegistration("ReplaceRegistration", {
          country: "US",
          countryOptions: { us: { state: "SD", type: "state_sales_tax" } },
        }),
      );

      // The jurisdiction is immutable — the engine must create a new record.
      expect(replaced.taxRegistrationId).not.toEqual(created.taxRegistrationId);

      // The replaced generation is expired, not deleted.
      const old = yield* GetTaxRegistrationsId({
        id: created.taxRegistrationId,
      });
      expect(old.status).toEqual("expired");

      yield* stack.destroy();
    }),
);

test.provider.skipIf(!LIVE)(
  "destroying an already-expired registration is idempotent",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const registration = yield* stack.deploy(
        Stripe.TaxRegistration("IdempotentDestroyRegistration", {
          country: "US",
          countryOptions: { us: { state: "DE", type: "state_sales_tax" } },
        }),
      );

      yield* stack.destroy();
      // A second destroy must not fail even though the registration is
      // already expired (and Stripe never removes it).
      yield* stack.destroy();

      const expired = yield* GetTaxRegistrationsId({
        id: registration.taxRegistrationId,
      });
      expect(expired.status).toEqual("expired");

      yield* stack.destroy();
    }),
);
