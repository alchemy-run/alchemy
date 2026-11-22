import * as Stripe from "@alchemy.run/stripe";
import { isMissingStripeResource } from "@alchemy.run/stripe/missing";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import {
  GetPaymentLink,
  CreatePrice,
  CreateProduct,
  UpdateProduct,
} from "@distilled.cloud/stripe/stripe";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Stripe.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const isMissing = isMissingStripeResource;

const waitUntilDeactivated = (id: string) =>
  GetPaymentLink({ payment_link: id }).pipe(
    Effect.map((link) => (link.active ? ("active" as const) : ("inactive" as const))),
    Effect.catchIf(isMissing, () => Effect.succeed("inactive" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "inactive",
      times: 10,
    }),
  );

const archiveProduct = (id: string) =>
  UpdateProduct({ id, active: false }).pipe(Effect.catchIf(isMissing, () => Effect.void));

test.provider(
  "create, update, and deactivate a payment link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const product = yield* CreateProduct({
        name: "Alchemy Payment Link Product",
      });
      const price = yield* CreatePrice({
        product: product.id,
        currency: "usd",
        unit_amount: 2000,
      });

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.PaymentLink("BuyLink", {
            lineItems: [{ price: price.id, quantity: 1 }],
            metadata: { campaign: "launch" },
          });
        }),
      );
      yield* expectFound(Stripe.PaymentLink.lookup({ id: created.id }), created);

      expect(created.id).toMatch(/^plink_/);
      expect(created.url).toEqual(expect.any(String));
      expect(created.active).toEqual(true);
      expect(created.lineItems).toEqual([
        expect.objectContaining({ price: price.id, quantity: 1 }),
      ]);
      expect(created.allowPromotionCodes).toEqual(false);
      expect(created.billingAddressCollection).toEqual("auto");
      expect(created.metadata).toMatchObject({ campaign: "launch" });
      expect(created.livemode).toEqual(false);

      const fetched = yield* GetPaymentLink({
        payment_link: created.id,
      });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.active).toEqual(true);
      expect(fetched.metadata?.campaign).toEqual("launch");
      expect(fetched.metadata?.[Stripe.alchemyMetadataKeys.stack]).toBeDefined();
      expect(fetched.metadata?.[Stripe.alchemyMetadataKeys.stage]).toBeDefined();
      expect(fetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.PaymentLink("BuyLink", {
            lineItems: [{ price: price.id, quantity: 2 }],
            allowPromotionCodes: true,
            inactiveMessage: "This link is no longer available.",
            metadata: { campaign: "spring", sku: "pro" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.lineItems).toEqual([
        expect.objectContaining({ price: price.id, quantity: 2 }),
      ]);
      expect(updated.allowPromotionCodes).toEqual(true);
      expect(updated.inactiveMessage).toEqual("This link is no longer available.");
      expect(updated.metadata).toEqual({ campaign: "spring", sku: "pro" });
      expect(updated.active).toEqual(true);

      const refetched = yield* GetPaymentLink({
        payment_link: updated.id,
      });
      expect(refetched.allow_promotion_codes).toEqual(true);
      expect(refetched.inactive_message).toEqual("This link is no longer available.");
      expect(refetched.metadata?.campaign).toEqual("spring");
      expect(refetched.metadata?.sku).toEqual("pro");
      expect(refetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      yield* stack.destroy();

      const deactivated = yield* waitUntilDeactivated(created.id);
      expect(deactivated).toEqual("inactive");

      yield* archiveProduct(product.id);
    }).pipe(logLevel),
  {
    tags: ["provider:stripe", "provider:stripe:paymentlink", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "list enumerates the deployed payment link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const product = yield* CreateProduct({
        name: "Alchemy Payment Link List Product",
      });
      const price = yield* CreatePrice({
        product: product.id,
        currency: "usd",
        unit_amount: 1500,
      });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.PaymentLink("ListLink", {
            lineItems: [{ price: price.id, quantity: 1 }],
            metadata: { kind: "list" },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.PaymentLink);
      const all = yield* provider.list();
      const found = all.find((link) => link.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.url).toEqual(deployed.url);
      expect(found?.metadata).toMatchObject({ kind: "list" });
      expect(found?.active).toEqual(true);

      yield* stack.destroy();

      const deactivated = yield* waitUntilDeactivated(deployed.id);
      expect(deactivated).toEqual("inactive");

      const after = yield* provider.list();
      expect(after.find((link) => link.id === deployed.id)).toBeUndefined();

      yield* archiveProduct(product.id);
    }).pipe(logLevel),
  {
    tags: ["provider:stripe", "provider:stripe:paymentlink", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "replace when line item price changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const product = yield* CreateProduct({
        name: "Alchemy Payment Link Replace Product",
      });
      const priceV1 = yield* CreatePrice({
        product: product.id,
        currency: "usd",
        unit_amount: 1000,
      });
      const priceV2 = yield* CreatePrice({
        product: product.id,
        currency: "usd",
        unit_amount: 2500,
      });

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.PaymentLink("ReplaceLink", {
            lineItems: [{ price: priceV1.id, quantity: 1 }],
          });
        }),
      );

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.PaymentLink("ReplaceLink", {
            lineItems: [{ price: priceV2.id, quantity: 1 }],
          });
        }),
      );

      expect(replaced.id).not.toEqual(created.id);
      expect(replaced.lineItems).toEqual([
        expect.objectContaining({ price: priceV2.id, quantity: 1 }),
      ]);

      const oldFetched = yield* GetPaymentLink({
        payment_link: created.id,
      });
      expect(oldFetched.active).toEqual(false);

      const newFetched = yield* GetPaymentLink({
        payment_link: replaced.id,
      });
      expect(newFetched.active).toEqual(true);

      yield* stack.destroy();

      const deactivated = yield* waitUntilDeactivated(replaced.id);
      expect(deactivated).toEqual("inactive");

      yield* archiveProduct(product.id);
    }).pipe(logLevel),
  {
    tags: ["provider:stripe", "provider:stripe:paymentlink", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "configure checkout options on a payment link and update them in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const product = yield* CreateProduct({ name: "Alchemy Checkout Options Product" });
      const price = yield* CreatePrice({ product: product.id, currency: "usd", unit_amount: 2500 });
      const addOn = yield* CreatePrice({ product: product.id, currency: "usd", unit_amount: 500 });

      const deployLink = (options: Partial<Stripe.PaymentLinkProps>) =>
        stack.deploy(
          Effect.gen(function* () {
            const shippingRate = yield* Stripe.ShippingRate("CheckoutShipping", {
              displayName: "Ground",
              amount: 500,
              currency: "usd",
            });
            const link = yield* Stripe.PaymentLink("CheckoutLink", {
              lineItems: [{ price: price.id, quantity: 1 }],
              shippingOptions: [{ shippingRate: shippingRate.id }],
              ...options,
            });
            return { link, shippingRate };
          }),
        );

      const { link: created, shippingRate } = yield* deployLink({
        automaticTax: { enabled: false },
        consentCollection: { paymentMethodReuseAgreement: { position: "hidden" } },
        customFields: [
          { key: "company", label: "Company", type: "text", optional: true },
          {
            key: "size",
            label: "Size",
            type: "dropdown",
            dropdown: {
              options: [
                { label: "Small", value: "s" },
                { label: "Large", value: "l" },
              ],
            },
          },
        ],
        customText: { submit: "We ship within two days." },
        invoiceCreation: { enabled: true, invoiceData: { footer: "Thanks!" } },
        nameCollection: { business: { enabled: true, optional: true } },
        optionalItems: [{ price: addOn.id, quantity: 1 }],
        paymentIntentData: {
          description: "Alchemy order",
          statementDescriptorSuffix: "ORDER",
          metadata: { channel: "web" },
        },
        paymentMethodTypes: ["card"],
        paymentMethodOptions: { card: { restrictions: { brandsBlocked: ["american_express"] } } },
        restrictions: { completedSessions: { limit: 100 } },
        shippingAddressCollection: { allowedCountries: ["US", "CA"] },
        taxIdCollection: { enabled: true, required: "never" },
      });

      expect(created.shippingOptions).toEqual([{ shippingRate: shippingRate.id }]);
      expect(created.customFields).toMatchObject([
        { key: "company", label: "Company", type: "text", optional: true },
        { key: "size", label: "Size", type: "dropdown" },
      ]);
      expect(created.customText).toMatchObject({ submit: "We ship within two days." });
      expect(created.invoiceCreation).toMatchObject({
        enabled: true,
        invoiceData: { footer: "Thanks!" },
      });
      expect(created.nameCollection).toMatchObject({ business: { enabled: true, optional: true } });
      expect(created.optionalItems).toMatchObject([{ price: addOn.id, quantity: 1 }]);
      expect(created.paymentIntentData).toMatchObject({
        description: "Alchemy order",
        statementDescriptorSuffix: "ORDER",
        metadata: { channel: "web" },
      });
      expect(created.paymentMethodTypes).toEqual(["card"]);
      expect(created.restrictions).toEqual({ completedSessions: { limit: 100, count: 0 } });
      expect(created.shippingAddressCollection).toEqual({ allowedCountries: ["US", "CA"] });
      expect(created.taxIdCollection).toMatchObject({ enabled: true, required: "never" });

      const fetched = yield* GetPaymentLink({ payment_link: created.id });
      expect(fetched.custom_fields.map((field) => field.key)).toEqual(["company", "size"]);
      expect(fetched.payment_intent_data?.metadata).toMatchObject({ channel: "web" });
      expect(fetched.payment_method_options?.card?.restrictions?.brands_blocked).toEqual([
        "american_express",
      ]);
      expect(fetched.restrictions?.completed_sessions.limit).toEqual(100);

      const { link: updated } = yield* deployLink({
        customFields: [{ key: "company", label: "Company name", type: "text" }],
        customText: { submit: "Ships in a week." },
        invoiceCreation: { enabled: false },
        paymentIntentData: { description: "Alchemy order v2" },
        restrictions: { completedSessions: { limit: 50 } },
        shippingAddressCollection: { allowedCountries: ["US"] },
        taxIdCollection: { enabled: false },
      });
      expect(updated.id).toEqual(created.id);
      expect(updated.url).toEqual(created.url);
      expect(updated.customFields).toMatchObject([{ key: "company", label: "Company name" }]);
      expect(updated.customText).toMatchObject({ submit: "Ships in a week." });
      expect(updated.invoiceCreation).toMatchObject({ enabled: false });
      expect(updated.paymentIntentData).toMatchObject({ description: "Alchemy order v2" });
      expect(updated.restrictions).toEqual({ completedSessions: { limit: 50, count: 0 } });
      expect(updated.shippingAddressCollection).toEqual({ allowedCountries: ["US"] });
      expect(updated.taxIdCollection).toMatchObject({ enabled: false });

      const refetched = yield* GetPaymentLink({ payment_link: created.id });
      expect(refetched.custom_fields.map((field) => field.label.custom)).toEqual(["Company name"]);
      expect(refetched.restrictions?.completed_sessions.limit).toEqual(50);

      yield* stack.destroy();

      expect(yield* waitUntilDeactivated(created.id)).toEqual("inactive");
      yield* archiveProduct(product.id);
    }).pipe(logLevel),
  {
    tags: ["provider:stripe", "provider:stripe:paymentlink", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "configure subscription data on a payment link and replace it when a create-only field changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const product = yield* CreateProduct({ name: "Alchemy Subscription Link Product" });
      const price = yield* CreatePrice({
        product: product.id,
        currency: "usd",
        unit_amount: 1500,
        recurring: { interval: "month" },
      });

      const deployLink = (subscriptionData: Stripe.PaymentLinkSubscriptionData) =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Stripe.PaymentLink("SubscriptionLink", {
              lineItems: [{ price: price.id, quantity: 1 }],
              subscriptionData,
            });
          }),
        );

      const created = yield* deployLink({
        description: "Pro plan",
        trialPeriodDays: 14,
        trialSettings: { endBehavior: { missingPaymentMethod: "cancel" } },
        metadata: { plan: "pro" },
      });
      expect(created.subscriptionData).toMatchObject({
        description: "Pro plan",
        trialPeriodDays: 14,
        trialSettings: { endBehavior: { missingPaymentMethod: "cancel" } },
        metadata: { plan: "pro" },
      });

      const updated = yield* deployLink({
        description: "Pro plan",
        trialPeriodDays: 30,
        trialSettings: { endBehavior: { missingPaymentMethod: "pause" } },
        metadata: { plan: "pro", cohort: "fall" },
      });
      expect(updated.id).toEqual(created.id);
      expect(updated.subscriptionData).toMatchObject({
        trialPeriodDays: 30,
        trialSettings: { endBehavior: { missingPaymentMethod: "pause" } },
        metadata: { plan: "pro", cohort: "fall" },
      });
      const fetched = yield* GetPaymentLink({ payment_link: created.id });
      expect(fetched.subscription_data?.trial_period_days).toEqual(30);

      const replaced = yield* deployLink({ description: "Pro plan (annual billing)" });
      expect(replaced.id).not.toEqual(created.id);
      expect(replaced.subscriptionData).toMatchObject({ description: "Pro plan (annual billing)" });
      expect(yield* waitUntilDeactivated(created.id)).toEqual("inactive");

      yield* stack.destroy();

      expect(yield* waitUntilDeactivated(replaced.id)).toEqual("inactive");
      yield* archiveProduct(product.id);
    }).pipe(logLevel),
  {
    tags: ["provider:stripe", "provider:stripe:paymentlink", "live"],
    timeout: 120_000,
  },
);
