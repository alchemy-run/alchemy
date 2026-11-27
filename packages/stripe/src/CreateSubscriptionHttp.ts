import { CreateSubscription as createSubscriptionOp } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { CreateSubscription } from "./CreateSubscription.ts";
import { makeHttpStripeAccountBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link CreateSubscription}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @product Billing
 * @provides Stripe.CreateSubscription
 */
export const CreateSubscriptionHttp = Layer.effect(
  CreateSubscription,
  makeHttpStripeAccountBinding({
    tag: "Stripe.CreateSubscription",
    operation: createSubscriptionOp,
    permissions: ["subscriptions_write"],
  }),
);
