import * as Stripe from "@alchemy.run/stripe";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import { GetPrice, GetProduct } from "@distilled.cloud/stripe/stripe";
import * as Output from "alchemy/Output";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

const { test } = Test.make({ providers: Stripe.providers() });

const tags = ["provider:stripe", "provider:stripe:product", "provider:stripe:price", "live"];

// The target belongs to another stack, as a lookup's target always should.
const target = () => Core.scratchStack({ providers: Stripe.providers() }, "StripeLookupTarget");

describe.concurrent("lookup", () => {
  test.provider(
    "a looked-up Product holds a declared Price and survives its destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const owner = target();
        yield* owner.destroy();
        const product = yield* owner.deploy(
          Stripe.Product("LookupTarget", { name: "Lookup target" }),
        );

        const program = Stripe.Price("OnLookedUpProduct", {
          product: Stripe.Product.lookup({ id: product.id }),
          currency: "usd",
          unitAmount: 1500,
        });
        const price = yield* stack.deploy(program);
        const stored = yield* GetPrice({ price: price.id });
        expect(stored.product).toEqual(product.id);

        // A lookup re-resolves to the same Product.
        const plan = yield* stack.plan(program);
        expect(plan.resources.OnLookedUpProduct?.action).toEqual("noop");

        // Destroying the consumer archives the Price, never the Product.
        yield* stack.destroy();
        const after = yield* GetProduct({ id: product.id });
        expect(after.active).toBe(true);

        yield* owner.destroy();
      }),
    { tags, timeout: 180_000 },
  );

  test.provider(
    "a lookup of a resource that doesn't exist fails the plan",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        // Well-formed ids nothing has: some endpoints reject a malformed id
        // before looking it up. `Account` is left out: only a Connect
        // platform can read another account, missing or not.
        const lookups = {
          Alert: Stripe.Alert.lookup({ id: "alrt_61ViPgGrcsM9Oxtm541F0iMJZ5935ZZZ" }),
          ApplePayDomain: Stripe.ApplePayDomain.lookup({ id: "apwc_AlchemyMissing0000" }),
          BillingMeter: Stripe.BillingMeter.lookup({ id: "mtr_AlchemyMissing0000" }),
          BillingPortalConfiguration: Stripe.BillingPortalConfiguration.lookup({
            id: "bpc_AlchemyMissing0000",
          }),
          Coupon: Stripe.Coupon.lookup({ id: "ALCHEMYMISSING0000" }),
          CreditGrant: Stripe.CreditGrant.lookup({
            id: "credgr_test_61ViPgGrcsM9Oxtm541F0iMJZ5935ZZZ",
          }),
          Customer: Stripe.Customer.lookup({ id: "cus_AlchemyMissing0000" }),
          EntitlementsFeature: Stripe.EntitlementsFeature.lookup({
            id: "feat_test_61ViPgW7tqrUvG3pP41F0iMJZ5935ZZZ",
          }),
          FileLink: Stripe.FileLink.lookup({ id: "link_AlchemyMissing0000" }),
          IssuingCard: Stripe.IssuingCard.lookup({ id: "ic_AlchemyMissing0000" }),
          IssuingCardholder: Stripe.IssuingCardholder.lookup({ id: "ich_AlchemyMissing0000" }),
          IssuingPersonalizationDesign: Stripe.IssuingPersonalizationDesign.lookup({
            id: "pd_AlchemyMissing0000",
          }),
          PaymentLink: Stripe.PaymentLink.lookup({ id: "plink_AlchemyMissing0000" }),
          PaymentMethodConfiguration: Stripe.PaymentMethodConfiguration.lookup({
            id: "pmc_AlchemyMissing0000",
          }),
          PaymentMethodDomain: Stripe.PaymentMethodDomain.lookup({ id: "pmd_AlchemyMissing0000" }),
          Plan: Stripe.Plan.lookup({ id: "plan_AlchemyMissing0000" }),
          Price: Stripe.Price.lookup({ id: "price_AlchemyMissing0000" }),
          Product: Stripe.Product.lookup({ id: "prod_AlchemyMissing0000" }),
          PromotionCode: Stripe.PromotionCode.lookup({ id: "promo_AlchemyMissing0000" }),
          RadarValueList: Stripe.RadarValueList.lookup({ id: "rsl_AlchemyMissing0000" }),
          ShippingRate: Stripe.ShippingRate.lookup({ id: "shr_AlchemyMissing0000" }),
          TaxRate: Stripe.TaxRate.lookup({ id: "txr_AlchemyMissing0000" }),
          TaxRegistration: Stripe.TaxRegistration.lookup({ id: "taxreg_1UZ1ieF0iMJZ5935cBWQ2ZZZ" }),
          TerminalConfiguration: Stripe.TerminalConfiguration.lookup({
            id: "tmc_AlchemyMissing0000",
          }),
          TerminalLocation: Stripe.TerminalLocation.lookup({ id: "tml_AlchemyMissing0000" }),
          TerminalReader: Stripe.TerminalReader.lookup({ id: "tmr_AlchemyMissing0000" }),
          WebhookEndpoint: Stripe.WebhookEndpoint.lookup({ id: "we_AlchemyMissing0000" }),
        } as unknown as Record<string, Output.Output<unknown>>;

        const mismatches: Record<string, string> = {};
        for (const [id, lookup] of Object.entries(lookups)) {
          const exit = yield* Effect.exit(
            stack.plan(
              Stripe.Product(id, { name: id, description: Output.interpolate`${lookup}` }),
            ),
          );
          const pretty = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "plan succeeded";
          if (!pretty.includes("LookupNotFoundError")) {
            mismatches[id] = pretty.split("\n")[0]!.slice(0, 300);
          }
        }
        expect(mismatches).toEqual({});
      }),
    { tags, timeout: 300_000 },
  );
});
