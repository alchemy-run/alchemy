import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetPaymentLinksPaymentLink } from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Stripe.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * A Product + one-time Price to hang line items off of. Deterministic logical
 * ids so re-runs converge on the same objects rather than piling up new ones.
 */
const oneTimeCatalog = Effect.gen(function* () {
  const product = yield* Stripe.Product("PaymentLinkProduct", {
    name: "Alchemy Payment Link Test Product",
  });
  const price = yield* Stripe.Price("PaymentLinkPrice", {
    productId: product.productId,
    currency: "usd",
    unitAmount: 2000,
  });
  return { product, price };
});

const recurringCatalog = Effect.gen(function* () {
  const product = yield* Stripe.Product("PaymentLinkSubProduct", {
    name: "Alchemy Payment Link Test Subscription",
  });
  const price = yield* Stripe.Price("PaymentLinkSubPrice", {
    productId: product.productId,
    currency: "usd",
    unitAmount: 4900,
    recurring: { interval: "month" },
  });
  return { product, price };
});

test.provider("create a payment link with minimal props", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const link = yield* stack.deploy(
      Effect.gen(function* () {
        const { price } = yield* oneTimeCatalog;
        return yield* Stripe.PaymentLink("MinimalLink", {
          lineItems: [{ priceId: price.priceId, quantity: 1 }],
        });
      }),
    );

    expect(link.paymentLinkId).toBeDefined();
    expect(link.paymentLinkId.startsWith("plink_")).toBe(true);
    expect(link.url).toContain("stripe.com");
    expect(link.active).toBe(true);
    expect(link.livemode).toBe(false);
    expect(link.currency).toBe("usd");
    // Alchemy's internal `alchemy_*` branding must not leak into the attrs.
    expect(link.metadata).toEqual({});

    const fetched = yield* GetPaymentLinksPaymentLink({
      payment_link: link.paymentLinkId,
    });
    expect(fetched.id).toEqual(link.paymentLinkId);
    expect(fetched.url).toEqual(link.url);
    expect(fetched.active).toBe(true);
    // The branding is on the object even though it's hidden from the attrs.
    expect(fetched.metadata.alchemy_id).toEqual("MinimalLink");
    expect(fetched.metadata.alchemy_stack).toBeDefined();
    expect(fetched.metadata.alchemy_stage).toBeDefined();

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("create a payment link with the full prop surface", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const link = yield* stack.deploy(
      Effect.gen(function* () {
        const { price } = yield* oneTimeCatalog;
        return yield* Stripe.PaymentLink("FullLink", {
          lineItems: [
            {
              priceId: price.priceId,
              quantity: 1,
              adjustableQuantity: { enabled: true, minimum: 1, maximum: 10 },
            },
          ],
          afterCompletion: {
            type: "redirect",
            redirect: {
              url: "https://example.com/thanks?s={CHECKOUT_SESSION_ID}",
            },
          },
          allowPromotionCodes: true,
          billingAddressCollection: "required",
          customText: {
            submit: "We ship within two business days.",
            afterSubmit: "Thanks for your order.",
          },
          customerCreation: "always",
          inactiveMessage: "This offer has ended.",
          invoiceCreation: {
            enabled: true,
            invoiceData: { description: "Alchemy test invoice" },
          },
          paymentMethodTypes: ["card"],
          phoneNumberCollection: { enabled: true },
          shippingAddressCollection: { allowedCountries: ["US", "CA"] },
          submitType: "pay",
          taxIdCollection: { enabled: true, required: "never" },
          metadata: { channel: "test" },
        });
      }),
    );

    expect(link.paymentLinkId).toBeDefined();
    expect(link.allowPromotionCodes).toBe(true);
    expect(link.billingAddressCollection).toEqual("required");
    expect(link.customerCreation).toEqual("always");
    expect(link.submitType).toEqual("pay");
    expect(link.inactiveMessage).toEqual("This offer has ended.");
    expect(link.paymentMethodTypes).toEqual(["card"]);
    expect(link.metadata).toEqual({ channel: "test" });

    const fetched = yield* GetPaymentLinksPaymentLink({
      payment_link: link.paymentLinkId,
    });
    expect(fetched.after_completion.type).toEqual("redirect");
    expect(fetched.after_completion.redirect?.url).toContain("example.com");
    expect(fetched.allow_promotion_codes).toBe(true);
    expect(fetched.billing_address_collection).toEqual("required");
    expect(fetched.custom_text.submit?.message).toEqual(
      "We ship within two business days.",
    );
    expect(fetched.custom_text.after_submit?.message).toEqual(
      "Thanks for your order.",
    );
    expect(fetched.customer_creation).toEqual("always");
    expect(fetched.inactive_message).toEqual("This offer has ended.");
    expect(fetched.invoice_creation?.enabled).toBe(true);
    expect(fetched.payment_method_types).toEqual(["card"]);
    expect(fetched.phone_number_collection.enabled).toBe(true);
    expect(fetched.shipping_address_collection?.allowed_countries).toEqual([
      "US",
      "CA",
    ]);
    expect(fetched.submit_type).toEqual("pay");
    expect(fetched.tax_id_collection.enabled).toBe(true);
    expect(fetched.metadata.channel).toEqual("test");
    expect(fetched.metadata.alchemy_id).toEqual("FullLink");

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("redeploying unchanged props is a no-op", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deploy = stack.deploy(
      Effect.gen(function* () {
        const { price } = yield* oneTimeCatalog;
        return yield* Stripe.PaymentLink("StableLink", {
          lineItems: [{ priceId: price.priceId, quantity: 1 }],
          submitType: "pay",
          metadata: { env: "test" },
        });
      }),
    );

    const created = yield* deploy;
    const again = yield* deploy;

    expect(again.paymentLinkId).toEqual(created.paymentLinkId);
    expect(again.url).toEqual(created.url);
    expect(again.active).toBe(true);
    expect(again.metadata).toEqual({ env: "test" });

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider(
  "mutable props update in place and keep the payment link id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const { price } = yield* oneTimeCatalog;
          return yield* Stripe.PaymentLink("UpdateLink", {
            lineItems: [{ priceId: price.priceId, quantity: 1 }],
            allowPromotionCodes: false,
            metadata: { stage: "one", drop: "me" },
          });
        }),
      );

      expect(created.allowPromotionCodes).toBe(false);
      expect(created.metadata).toEqual({ stage: "one", drop: "me" });

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const { price } = yield* oneTimeCatalog;
          return yield* Stripe.PaymentLink("UpdateLink", {
            lineItems: [{ priceId: price.priceId, quantity: 1 }],
            allowPromotionCodes: true,
            billingAddressCollection: "required",
            inactiveMessage: "Come back soon.",
            metadata: { stage: "two" },
          });
        }),
      );

      // In-place update: same object, same URL.
      expect(updated.paymentLinkId).toEqual(created.paymentLinkId);
      expect(updated.url).toEqual(created.url);
      expect(updated.allowPromotionCodes).toBe(true);
      expect(updated.billingAddressCollection).toEqual("required");
      expect(updated.inactiveMessage).toEqual("Come back soon.");
      // `drop` was removed from props, so Stripe must have unset the key.
      expect(updated.metadata).toEqual({ stage: "two" });

      const fetched = yield* GetPaymentLinksPaymentLink({
        payment_link: updated.paymentLinkId,
      });
      expect(fetched.allow_promotion_codes).toBe(true);
      expect(fetched.billing_address_collection).toEqual("required");
      expect(fetched.inactive_message).toEqual("Come back soon.");
      expect(fetched.metadata.stage).toEqual("two");
      expect(fetched.metadata.drop).toBeUndefined();

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider("deactivating a link is an in-place update", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Effect.gen(function* () {
        const { price } = yield* oneTimeCatalog;
        return yield* Stripe.PaymentLink("ActiveToggleLink", {
          lineItems: [{ priceId: price.priceId, quantity: 1 }],
        });
      }),
    );
    expect(created.active).toBe(true);

    const deactivated = yield* stack.deploy(
      Effect.gen(function* () {
        const { price } = yield* oneTimeCatalog;
        return yield* Stripe.PaymentLink("ActiveToggleLink", {
          lineItems: [{ priceId: price.priceId, quantity: 1 }],
          active: false,
        });
      }),
    );
    expect(deactivated.paymentLinkId).toEqual(created.paymentLinkId);
    expect(deactivated.active).toBe(false);

    let fetched = yield* GetPaymentLinksPaymentLink({
      payment_link: deactivated.paymentLinkId,
    });
    expect(fetched.active).toBe(false);

    const reactivated = yield* stack.deploy(
      Effect.gen(function* () {
        const { price } = yield* oneTimeCatalog;
        return yield* Stripe.PaymentLink("ActiveToggleLink", {
          lineItems: [{ priceId: price.priceId, quantity: 1 }],
          active: true,
        });
      }),
    );
    expect(reactivated.paymentLinkId).toEqual(created.paymentLinkId);
    expect(reactivated.active).toBe(true);

    fetched = yield* GetPaymentLinksPaymentLink({
      payment_link: reactivated.paymentLinkId,
    });
    expect(fetched.active).toBe(true);

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("changing line items replaces the payment link", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Effect.gen(function* () {
        const { price } = yield* oneTimeCatalog;
        return yield* Stripe.PaymentLink("ReplaceLink", {
          lineItems: [{ priceId: price.priceId, quantity: 1 }],
        });
      }),
    );

    const replaced = yield* stack.deploy(
      Effect.gen(function* () {
        const { price } = yield* oneTimeCatalog;
        return yield* Stripe.PaymentLink("ReplaceLink", {
          lineItems: [{ priceId: price.priceId, quantity: 3 }],
        });
      }),
    );

    // `line_items` is create-only on Stripe, so the engine must have built a
    // brand new payment link (with a brand new URL).
    expect(replaced.paymentLinkId).not.toEqual(created.paymentLinkId);
    expect(replaced.url).not.toEqual(created.url);

    // The replaced generation is archived, not deleted — Stripe has no
    // delete endpoint for payment links.
    const old = yield* GetPaymentLinksPaymentLink({
      payment_link: created.paymentLinkId,
    });
    expect(old.active).toBe(false);

    const current = yield* GetPaymentLinksPaymentLink({
      payment_link: replaced.paymentLinkId,
    });
    expect(current.active).toBe(true);

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("destroying a payment link archives it", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const link = yield* stack.deploy(
      Effect.gen(function* () {
        const { price } = yield* oneTimeCatalog;
        return yield* Stripe.PaymentLink("ArchiveLink", {
          lineItems: [{ priceId: price.priceId, quantity: 1 }],
        });
      }),
    );
    expect(link.active).toBe(true);

    yield* stack.destroy();

    // Stripe cannot delete payment links; destroy must leave the object in
    // place with `active: false` rather than erroring.
    const fetched = yield* GetPaymentLinksPaymentLink({
      payment_link: link.paymentLinkId,
    });
    expect(fetched.id).toEqual(link.paymentLinkId);
    expect(fetched.active).toBe(false);

    // Destroying twice is idempotent.
    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("subscription payment link with a trial", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const link = yield* stack.deploy(
      Effect.gen(function* () {
        const { price } = yield* recurringCatalog;
        return yield* Stripe.PaymentLink("SubscriptionLink", {
          lineItems: [{ priceId: price.priceId, quantity: 1 }],
          submitType: "subscribe",
          subscriptionData: {
            trialPeriodDays: 14,
            trialSettings: {
              endBehavior: { missingPaymentMethod: "cancel" },
            },
          },
        });
      }),
    );

    expect(link.paymentLinkId).toBeDefined();
    expect(link.submitType).toEqual("subscribe");

    const fetched = yield* GetPaymentLinksPaymentLink({
      payment_link: link.paymentLinkId,
    });
    expect(fetched.subscription_data?.trial_period_days).toEqual(14);
    expect(
      fetched.subscription_data?.trial_settings?.end_behavior
        .missing_payment_method,
    ).toEqual("cancel");

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider(
  "inline price data creates the price alongside the link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const link = yield* stack.deploy(
        Stripe.PaymentLink("InlinePriceLink", {
          lineItems: [
            {
              quantity: 1,
              priceData: {
                currency: "usd",
                unitAmount: 500,
                productData: { name: "Alchemy Inline Donation" },
              },
            },
          ],
          submitType: "donate",
        }),
      );

      expect(link.paymentLinkId).toBeDefined();
      expect(link.currency).toEqual("usd");
      expect(link.submitType).toEqual("donate");

      const fetched = yield* GetPaymentLinksPaymentLink({
        payment_link: link.paymentLinkId,
      });
      expect(fetched.currency).toEqual("usd");
      expect(fetched.submit_type).toEqual("donate");

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider("list enumerates the deployed payment link", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const link = yield* stack.deploy(
      Effect.gen(function* () {
        const { price } = yield* oneTimeCatalog;
        return yield* Stripe.PaymentLink("ListLink", {
          lineItems: [{ priceId: price.priceId, quantity: 1 }],
        });
      }),
    );

    const provider = yield* Provider.findProvider(Stripe.PaymentLink);
    const all = yield* provider.list();

    const found = all.find((l) => l.paymentLinkId === link.paymentLinkId);
    expect(found).toBeDefined();
    expect(found?.url).toEqual(link.url);
    expect(found?.active).toBe(true);

    yield* stack.destroy();
  }).pipe(logLevel),
);
