import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetPaymentMethodConfigurationsConfiguration } from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Stripe.providers() });

/**
 * A Connect **parent** payment method configuration cannot be created through
 * the API (they are dashboard-managed), so the only replacement trigger —
 * changing `parent` — needs a pre-existing parent id supplied out of band.
 */
const PARENT_CONFIGURATION = process.env.STRIPE_TEST_PMC_PARENT;

test.provider("create and archive a payment method configuration", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const config = yield* stack.deploy(
      Stripe.PaymentMethodConfiguration("MinimalConfiguration", {
        card: { displayPreference: { preference: "on" } },
      }),
    );

    expect(config.paymentMethodConfigurationId).toBeDefined();
    expect(config.paymentMethodConfigurationId.startsWith("pmc_")).toBe(true);
    expect(config.active).toBe(true);
    expect(config.name).toBeDefined();
    expect(config.parent).toBeUndefined();
    expect(config.paymentMethods.card?.preference).toEqual("on");

    const fetched = yield* GetPaymentMethodConfigurationsConfiguration({
      configuration: config.paymentMethodConfigurationId,
    });
    expect(fetched.id).toEqual(config.paymentMethodConfigurationId);
    expect(fetched.active).toBe(true);
    expect(fetched.name).toEqual(config.name);

    yield* stack.destroy();

    // Stripe cannot delete a payment method configuration — destroy archives
    // it, so the object survives with `active: false`.
    const archived = yield* GetPaymentMethodConfigurationsConfiguration({
      configuration: config.paymentMethodConfigurationId,
    });
    expect(archived.id).toEqual(config.paymentMethodConfigurationId);
    expect(archived.active).toBe(false);

    yield* stack.destroy();
  }),
);

test.provider(
  "create a configuration with a wide payment method set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const config = yield* stack.deploy(
        Stripe.PaymentMethodConfiguration("WideConfiguration", {
          name: "alchemy-test-wide-configuration",
          card: { displayPreference: { preference: "on" } },
          link: { displayPreference: { preference: "on" } },
          applePay: { displayPreference: { preference: "on" } },
          googlePay: { displayPreference: { preference: "on" } },
          klarna: { displayPreference: { preference: "off" } },
          affirm: { displayPreference: { preference: "off" } },
          afterpayClearpay: { displayPreference: { preference: "off" } },
          cashapp: { displayPreference: { preference: "none" } },
          usBankAccount: { displayPreference: { preference: "none" } },
        }),
      );

      expect(config.name).toEqual("alchemy-test-wide-configuration");
      expect(config.paymentMethods.card?.preference).toEqual("on");
      expect(config.paymentMethods.link?.preference).toEqual("on");
      expect(config.paymentMethods.applePay?.preference).toEqual("on");
      expect(config.paymentMethods.googlePay?.preference).toEqual("on");
      expect(config.paymentMethods.klarna?.preference).toEqual("off");
      expect(config.paymentMethods.affirm?.preference).toEqual("off");
      expect(config.paymentMethods.afterpayClearpay?.preference).toEqual("off");
      expect(config.paymentMethods.cashapp?.preference).toEqual("none");
      expect(config.paymentMethods.usBankAccount?.preference).toEqual("none");

      const fetched = yield* GetPaymentMethodConfigurationsConfiguration({
        configuration: config.paymentMethodConfigurationId,
      });
      expect(fetched.name).toEqual("alchemy-test-wide-configuration");
      expect(fetched.card?.display_preference.preference).toEqual("on");
      expect(fetched.klarna?.display_preference.preference).toEqual("off");

      yield* stack.destroy();
    }),
);

test.provider("update name and preferences in place", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.PaymentMethodConfiguration("UpdateConfiguration", {
        name: "alchemy-test-update-before",
        card: { displayPreference: { preference: "on" } },
        link: { displayPreference: { preference: "off" } },
      }),
    );
    expect(created.paymentMethods.link?.preference).toEqual("off");

    const updated = yield* stack.deploy(
      Stripe.PaymentMethodConfiguration("UpdateConfiguration", {
        name: "alchemy-test-update-after",
        card: { displayPreference: { preference: "on" } },
        link: { displayPreference: { preference: "on" } },
      }),
    );

    // In-place update: the id must survive.
    expect(updated.paymentMethodConfigurationId).toEqual(
      created.paymentMethodConfigurationId,
    );
    expect(updated.name).toEqual("alchemy-test-update-after");
    expect(updated.paymentMethods.link?.preference).toEqual("on");
    expect(updated.paymentMethods.card?.preference).toEqual("on");

    const fetched = yield* GetPaymentMethodConfigurationsConfiguration({
      configuration: updated.paymentMethodConfigurationId,
    });
    expect(fetched.name).toEqual("alchemy-test-update-after");
    expect(fetched.link?.display_preference.preference).toEqual("on");

    yield* stack.destroy();
  }),
);

test.provider("re-deploying identical props is a no-op", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deploy = stack.deploy(
      Stripe.PaymentMethodConfiguration("NoopConfiguration", {
        name: "alchemy-test-noop-configuration",
        card: { displayPreference: { preference: "on" } },
        link: { displayPreference: { preference: "on" } },
      }),
    );

    const created = yield* deploy;
    const again = yield* deploy;

    expect(again.paymentMethodConfigurationId).toEqual(
      created.paymentMethodConfigurationId,
    );
    expect(again.name).toEqual(created.name);
    expect(again.paymentMethods.card?.preference).toEqual("on");
    expect(again.paymentMethods.link?.preference).toEqual("on");

    yield* stack.destroy();
  }),
);

test.provider(
  "destroying an already-archived configuration is idempotent",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const config = yield* stack.deploy(
        Stripe.PaymentMethodConfiguration("IdempotentDestroyConfiguration", {
          card: { displayPreference: { preference: "on" } },
        }),
      );

      yield* stack.destroy();
      // A second destroy must not fail even though the configuration is
      // already archived (and Stripe never removes it).
      yield* stack.destroy();

      const archived = yield* GetPaymentMethodConfigurationsConfiguration({
        configuration: config.paymentMethodConfigurationId,
      });
      expect(archived.active).toBe(false);

      yield* stack.destroy();
    }),
);

test.provider("list enumerates the deployed configuration", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Stripe.PaymentMethodConfiguration("ListConfiguration", {
        card: { displayPreference: { preference: "on" } },
      }),
    );

    const provider = yield* Provider.findProvider(
      Stripe.PaymentMethodConfiguration,
    );
    const all = yield* provider.list();

    const found = all.find(
      (configuration) =>
        configuration.paymentMethodConfigurationId ===
        deployed.paymentMethodConfigurationId,
    );
    expect(found).toBeDefined();
    expect(found!.name).toEqual(deployed.name);
    expect(found!.paymentMethods.card?.preference).toEqual("on");

    yield* stack.destroy();
  }),
);

test.provider.skipIf(!PARENT_CONFIGURATION)(
  "changing parent replaces the configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stripe.PaymentMethodConfiguration("ReplaceConfiguration", {
          card: { displayPreference: { preference: "on" } },
        }),
      );
      expect(created.parent).toBeUndefined();

      const replaced = yield* stack.deploy(
        Stripe.PaymentMethodConfiguration("ReplaceConfiguration", {
          parent: PARENT_CONFIGURATION!,
          card: { displayPreference: { preference: "on" } },
        }),
      );

      // `parent` is immutable — the engine must have created a new object.
      expect(replaced.paymentMethodConfigurationId).not.toEqual(
        created.paymentMethodConfigurationId,
      );
      expect(replaced.parent).toEqual(PARENT_CONFIGURATION);

      // The replaced generation is archived, not deleted.
      const old = yield* GetPaymentMethodConfigurationsConfiguration({
        configuration: created.paymentMethodConfigurationId,
      });
      expect(old.active).toBe(false);

      yield* stack.destroy();
    }),
);
