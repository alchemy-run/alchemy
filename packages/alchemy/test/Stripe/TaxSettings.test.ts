import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetTaxSettings } from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Stripe.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * Stripe Tax must be enabled on the account before `POST /v1/tax/settings`
 * will accept anything, and the object is an **account-wide singleton** —
 * running these tests rewrites configuration shared by every stack and every
 * stage pointed at the same Stripe account. Gate them behind an explicit
 * opt-in so a plain `pnpm test` can never mutate a shared account.
 */
const ENABLED = !!process.env.STRIPE_TEST_TAX;

/** Deterministic addresses — never derived from the clock or a random source. */
const HEAD_OFFICE = {
  address: {
    line1: "354 Oyster Point Blvd",
    city: "South San Francisco",
    state: "CA",
    postalCode: "94080",
    country: "US",
  },
} as const;

const UPDATED_HEAD_OFFICE = {
  address: {
    line1: "510 Townsend St",
    line2: "Floor 2",
    city: "San Francisco",
    state: "CA",
    postalCode: "94103",
    country: "US",
  },
} as const;

/** Stripe's "General - Tangible Goods" / "General - Services" tax codes. */
const TAX_CODE_GOODS = "txcd_99999999";
const TAX_CODE_SERVICES = "txcd_20030000";

test.provider.skipIf(!ENABLED)(
  "captures, converges and restores the account tax settings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Capture the account's pre-test state out-of-band so we can verify
      // both the snapshot the provider takes and the restore on destroy.
      const baseline = yield* GetTaxSettings({});
      const baselineTaxCode = baseline.defaults.tax_code ?? undefined;
      const baselineTaxBehavior = baseline.defaults.tax_behavior ?? undefined;
      const baselineCountry =
        baseline.head_office?.address.country ?? undefined;

      // (a) Minimal create — only the head office, no defaults declared.
      const created = yield* stack.deploy(
        Stripe.TaxSettings("TaxSettings", { headOffice: HEAD_OFFICE }),
      );

      expect(created.taxSettingsId).toEqual("tax_settings");
      expect(created.headOffice?.address.line1).toEqual(
        HEAD_OFFICE.address.line1,
      );
      expect(created.headOffice?.address.postalCode).toEqual(
        HEAD_OFFICE.address.postalCode,
      );
      expect(created.headOffice?.address.country).toEqual("US");
      // A head office is all Stripe needs, so the settings go active.
      expect(created.status).toEqual("active");
      expect(created.statusDetails.missingFields).toEqual([]);
      expect(created.defaults.provider).toBeDefined();
      // The pre-management snapshot was captured for the restore.
      expect(created.previousSettings.defaults.taxCode).toEqual(
        baselineTaxCode,
      );
      expect(created.previousSettings.defaults.taxBehavior).toEqual(
        baselineTaxBehavior,
      );
      expect(created.previousSettings.headOffice?.address.country).toEqual(
        baselineCountry,
      );

      // Verify out-of-band rather than trusting the returned attrs.
      const live = yield* GetTaxSettings({});
      expect(live.head_office?.address.line1).toEqual(
        HEAD_OFFICE.address.line1,
      );
      expect(live.head_office?.address.postal_code).toEqual(
        HEAD_OFFICE.address.postalCode,
      );

      // (b) Full-prop deploy — every supported field at once.
      const configured = yield* stack.deploy(
        Stripe.TaxSettings("TaxSettings", {
          defaults: {
            taxCode: TAX_CODE_GOODS,
            taxBehavior: "exclusive",
          },
          headOffice: UPDATED_HEAD_OFFICE,
        }),
      );

      expect(configured.defaults.taxCode).toEqual(TAX_CODE_GOODS);
      expect(configured.defaults.taxBehavior).toEqual("exclusive");
      expect(configured.headOffice?.address.line1).toEqual(
        UPDATED_HEAD_OFFICE.address.line1,
      );
      expect(configured.headOffice?.address.line2).toEqual(
        UPDATED_HEAD_OFFICE.address.line2,
      );
      // The singleton is never replaced: the id and the original capture
      // both survive every update.
      expect(configured.taxSettingsId).toEqual(created.taxSettingsId);
      expect(configured.previousSettings).toEqual(created.previousSettings);

      const liveConfigured = yield* GetTaxSettings({});
      expect(liveConfigured.defaults.tax_code).toEqual(TAX_CODE_GOODS);
      expect(liveConfigured.defaults.tax_behavior).toEqual("exclusive");
      expect(liveConfigured.head_office?.address.line2).toEqual(
        UPDATED_HEAD_OFFICE.address.line2,
      );

      // (c) In-place update — change one field; the id must not change and
      //     the untouched fields must be left exactly as they were.
      const updated = yield* stack.deploy(
        Stripe.TaxSettings("TaxSettings", {
          defaults: {
            taxCode: TAX_CODE_SERVICES,
            taxBehavior: "exclusive",
          },
          headOffice: UPDATED_HEAD_OFFICE,
        }),
      );

      expect(updated.taxSettingsId).toEqual(created.taxSettingsId);
      expect(updated.defaults.taxCode).toEqual(TAX_CODE_SERVICES);
      expect(updated.defaults.taxBehavior).toEqual("exclusive");
      expect(updated.headOffice?.address.line1).toEqual(
        UPDATED_HEAD_OFFICE.address.line1,
      );
      expect(updated.previousSettings).toEqual(created.previousSettings);

      const liveUpdated = yield* GetTaxSettings({});
      expect(liveUpdated.defaults.tax_code).toEqual(TAX_CODE_SERVICES);

      // (d) A no-op redeploy converges to exactly the same state — this is
      //     the observed-vs-desired diff proving reconcile is idempotent.
      const again = yield* stack.deploy(
        Stripe.TaxSettings("TaxSettings", {
          defaults: {
            taxCode: TAX_CODE_SERVICES,
            taxBehavior: "exclusive",
          },
          headOffice: UPDATED_HEAD_OFFICE,
        }),
      );
      expect(again.defaults.taxCode).toEqual(TAX_CODE_SERVICES);
      expect(again.headOffice).toEqual(updated.headOffice);
      expect(again.previousSettings).toEqual(created.previousSettings);

      // (e) Destroy restores the captured snapshot rather than deleting —
      //     the settings object still exists afterwards.
      yield* stack.destroy();

      const restored = yield* GetTaxSettings({});
      expect(restored.object).toEqual("tax.settings");
      // Only fields that previously HAD a value can come back: Stripe has no
      // un-set for `tax_code`, and documents `tax_behavior` as one-way.
      if (baselineTaxCode !== undefined) {
        expect(restored.defaults.tax_code).toEqual(baselineTaxCode);
      }
      if (baselineTaxBehavior !== undefined) {
        expect(restored.defaults.tax_behavior).toEqual(baselineTaxBehavior);
      }
      if (baselineCountry !== undefined) {
        expect(restored.head_office?.address.country).toEqual(baselineCountry);
      }

      // A second destroy is a no-op — the restore is idempotent.
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Canonical `list()` test for an account singleton: there is no enumeration
// API, so `list` reads the one instance and returns it as a one-element
// array. Asserts exactly one well-typed Attributes for the ambient account.
test.provider.skipIf(!ENABLED)(
  "list returns the account's tax settings singleton",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(Stripe.TaxSettings);
      const all = yield* provider.list();

      expect(all.length).toEqual(1);
      const [settings] = all;
      expect(settings.taxSettingsId).toEqual("tax_settings");
      expect(settings.defaults.provider).toBeDefined();
      // Nothing is managed from this angle, so the observed snapshot is its
      // own restore target.
      expect(settings.previousSettings).toBeDefined();
      expect(settings.previousSettings.defaults.taxCode).toEqual(
        settings.defaults.taxCode,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
