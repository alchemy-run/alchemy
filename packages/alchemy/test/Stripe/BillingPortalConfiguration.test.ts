import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetBillingPortalConfigurationsConfiguration } from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Stripe.providers() });

test.provider(
  "create and archive a configuration with minimal props",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const configuration = yield* stack.deploy(
        Stripe.BillingPortalConfiguration("MinimalPortal", {
          features: {
            invoiceHistory: { enabled: true },
          },
        }),
      );

      expect(configuration.billingPortalConfigurationId).toMatch(/^bpc_/);
      expect(configuration.active).toEqual(true);
      expect(configuration.isDefault).toEqual(false);
      expect(configuration.features.invoiceHistory.enabled).toEqual(true);
      // Every unspecified feature resolves to Stripe's default (off).
      expect(configuration.features.customerUpdate.enabled).toEqual(false);
      expect(configuration.features.subscriptionCancel.enabled).toEqual(false);
      expect(configuration.features.subscriptionCancel.mode).toEqual(
        "at_period_end",
      );
      expect(configuration.features.subscriptionUpdate.enabled).toEqual(false);
      expect(
        configuration.features.subscriptionUpdate.billingCycleAnchor,
      ).toEqual("unchanged");
      expect(configuration.loginPage.enabled).toEqual(false);
      // Alchemy's own `alchemy_*` branding never leaks into the attribute.
      expect(configuration.metadata).toEqual({});

      const fetched = yield* GetBillingPortalConfigurationsConfiguration({
        configuration: configuration.billingPortalConfigurationId,
      });
      expect(fetched.id).toEqual(configuration.billingPortalConfigurationId);
      expect(fetched.active).toEqual(true);
      expect(fetched.features.invoice_history.enabled).toEqual(true);
      // …but it IS written to Stripe, so a lost state row can re-adopt.
      expect(fetched.metadata?.alchemy_id).toEqual("MinimalPortal");

      yield* stack.destroy();

      // Stripe cannot delete a portal configuration — destroy archives it.
      const archived = yield* GetBillingPortalConfigurationsConfiguration({
        configuration: configuration.billingPortalConfigurationId,
      });
      expect(archived.id).toEqual(configuration.billingPortalConfigurationId);
      expect(archived.active).toEqual(false);
    }),
);

test.provider("create a configuration with the full prop surface", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const configuration = yield* stack.deploy(
      Stripe.BillingPortalConfiguration("FullPortal", {
        name: "alchemy-full-portal",
        businessProfile: {
          headline: "Alchemy — manage your subscription",
          privacyPolicyUrl: "https://example.com/privacy",
          termsOfServiceUrl: "https://example.com/terms",
        },
        defaultReturnUrl: "https://example.com/account",
        loginPage: { enabled: true },
        metadata: { team: "billing" },
        features: {
          invoiceHistory: { enabled: true },
          customerUpdate: {
            enabled: true,
            allowedUpdates: ["address", "email", "tax_id"],
          },
          paymentMethodUpdate: { enabled: true },
          subscriptionCancel: {
            enabled: true,
            mode: "at_period_end",
            prorationBehavior: "none",
            cancellationReason: {
              enabled: true,
              options: ["too_expensive", "missing_features", "other"],
            },
          },
        },
      }),
    );

    expect(configuration.name).toEqual("alchemy-full-portal");
    expect(configuration.defaultReturnUrl).toEqual(
      "https://example.com/account",
    );
    expect(configuration.businessProfile).toEqual({
      headline: "Alchemy — manage your subscription",
      privacyPolicyUrl: "https://example.com/privacy",
      termsOfServiceUrl: "https://example.com/terms",
    });
    // Enum lists are normalized (sorted) so a reordered prop is not drift.
    expect(configuration.features.customerUpdate.allowedUpdates).toEqual([
      "address",
      "email",
      "tax_id",
    ]);
    expect(
      configuration.features.subscriptionCancel.cancellationReason.options,
    ).toEqual(["missing_features", "other", "too_expensive"]);
    expect(configuration.features.paymentMethodUpdate.enabled).toEqual(true);
    expect(configuration.loginPage.enabled).toEqual(true);
    expect(configuration.loginPage.url).toBeDefined();
    // User metadata survives; alchemy's branding is stripped from the attr.
    expect(configuration.metadata).toEqual({ team: "billing" });

    const fetched = yield* GetBillingPortalConfigurationsConfiguration({
      configuration: configuration.billingPortalConfigurationId,
    });
    expect(fetched.name).toEqual("alchemy-full-portal");
    expect(fetched.default_return_url).toEqual("https://example.com/account");
    expect(fetched.business_profile.headline).toEqual(
      "Alchemy — manage your subscription",
    );
    expect(fetched.features.customer_update.enabled).toEqual(true);
    expect(
      fetched.features.subscription_cancel.cancellation_reason.enabled,
    ).toEqual(true);
    expect(fetched.login_page.enabled).toEqual(true);
    expect(fetched.metadata?.team).toEqual("billing");
    expect(fetched.metadata?.alchemy_id).toEqual("FullPortal");

    yield* stack.destroy();
  }),
);

test.provider("update every mutable field in place", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.BillingPortalConfiguration("UpdatePortal", {
        name: "alchemy-update-portal",
        businessProfile: { headline: "Before" },
        defaultReturnUrl: "https://example.com/before",
        metadata: { phase: "before", dropped: "yes" },
        features: {
          invoiceHistory: { enabled: true },
          customerUpdate: { enabled: true, allowedUpdates: ["email"] },
        },
      }),
    );

    expect(created.name).toEqual("alchemy-update-portal");
    expect(created.businessProfile.headline).toEqual("Before");
    expect(created.metadata).toEqual({ phase: "before", dropped: "yes" });

    // Every modelled field is mutable — there is no provider-driven
    // replacement path, so the configuration id must survive the change.
    const updated = yield* stack.deploy(
      Stripe.BillingPortalConfiguration("UpdatePortal", {
        name: "alchemy-update-portal-renamed",
        businessProfile: { headline: "After" },
        defaultReturnUrl: "https://example.com/after",
        metadata: { phase: "after" },
        features: {
          invoiceHistory: { enabled: true },
          customerUpdate: {
            enabled: true,
            allowedUpdates: ["email", "phone", "address"],
          },
          subscriptionCancel: { enabled: true, mode: "immediately" },
        },
      }),
    );

    expect(updated.billingPortalConfigurationId).toEqual(
      created.billingPortalConfigurationId,
    );
    expect(updated.name).toEqual("alchemy-update-portal-renamed");
    expect(updated.businessProfile.headline).toEqual("After");
    expect(updated.defaultReturnUrl).toEqual("https://example.com/after");
    expect(updated.features.customerUpdate.allowedUpdates).toEqual([
      "address",
      "email",
      "phone",
    ]);
    expect(updated.features.subscriptionCancel.enabled).toEqual(true);
    expect(updated.features.subscriptionCancel.mode).toEqual("immediately");
    // A metadata key the user removed is unset, not left behind.
    expect(updated.metadata).toEqual({ phase: "after" });

    const fetched = yield* GetBillingPortalConfigurationsConfiguration({
      configuration: updated.billingPortalConfigurationId,
    });
    expect(fetched.name).toEqual("alchemy-update-portal-renamed");
    expect(fetched.business_profile.headline).toEqual("After");
    expect(fetched.features.subscription_cancel.mode).toEqual("immediately");
    expect(fetched.metadata?.dropped).toBeUndefined();

    yield* stack.destroy();
  }),
);

test.provider("dropping an optional prop unsets it in Stripe", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.BillingPortalConfiguration("UnsetPortal", {
        name: "alchemy-unset-portal",
        defaultReturnUrl: "https://example.com/return",
        businessProfile: {
          headline: "Headline",
          privacyPolicyUrl: "https://example.com/privacy",
        },
        features: { invoiceHistory: { enabled: true } },
      }),
    );
    expect(created.defaultReturnUrl).toEqual("https://example.com/return");
    expect(created.businessProfile.headline).toEqual("Headline");

    const cleared = yield* stack.deploy(
      Stripe.BillingPortalConfiguration("UnsetPortal", {
        features: { invoiceHistory: { enabled: true } },
      }),
    );

    expect(cleared.billingPortalConfigurationId).toEqual(
      created.billingPortalConfigurationId,
    );
    expect(cleared.name).toBeUndefined();
    expect(cleared.defaultReturnUrl).toBeUndefined();
    expect(cleared.businessProfile.headline).toBeUndefined();
    expect(cleared.businessProfile.privacyPolicyUrl).toBeUndefined();

    const fetched = yield* GetBillingPortalConfigurationsConfiguration({
      configuration: cleared.billingPortalConfigurationId,
    });
    expect(fetched.name).toBeNull();
    expect(fetched.default_return_url).toBeNull();
    expect(fetched.business_profile.headline).toBeNull();

    yield* stack.destroy();
  }),
);

test.provider("redeploying identical props is a no-op", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deploy = stack.deploy(
      Stripe.BillingPortalConfiguration("StablePortal", {
        name: "alchemy-stable-portal",
        features: {
          invoiceHistory: { enabled: true },
          customerUpdate: { enabled: true, allowedUpdates: ["email"] },
        },
      }),
    );

    const created = yield* deploy;
    const again = yield* deploy;

    expect(again.billingPortalConfigurationId).toEqual(
      created.billingPortalConfigurationId,
    );
    // `updated` only moves when a POST actually reached Stripe, so an equal
    // redeploy proves the reconciler skipped the update API entirely.
    expect(again.updated).toEqual(created.updated);

    yield* stack.destroy();
  }),
);

test.provider("archive is idempotent across repeated destroys", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const configuration = yield* stack.deploy(
      Stripe.BillingPortalConfiguration("IdempotentPortal", {
        features: { invoiceHistory: { enabled: true } },
      }),
    );

    yield* stack.destroy();
    // A second destroy must not fail on an already-archived configuration.
    yield* stack.destroy();

    const archived = yield* GetBillingPortalConfigurationsConfiguration({
      configuration: configuration.billingPortalConfigurationId,
    });
    expect(archived.active).toEqual(false);
  }),
);

test.provider("create an inactive configuration", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    // Stripe's create API has no `active` field, so the reconciler creates
    // the configuration active and archives it in the sync step.
    const configuration = yield* stack.deploy(
      Stripe.BillingPortalConfiguration("InactivePortal", {
        active: false,
        features: { invoiceHistory: { enabled: true } },
      }),
    );

    expect(configuration.active).toEqual(false);

    const fetched = yield* GetBillingPortalConfigurationsConfiguration({
      configuration: configuration.billingPortalConfigurationId,
    });
    expect(fetched.active).toEqual(false);

    yield* stack.destroy();
  }),
);
