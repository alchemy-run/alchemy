import { UpdateSubscription as updateSubscriptionOp } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { makeHttpStripeAccountBinding } from "./StripeHttp.ts";
import { UpdateSubscription } from "./UpdateSubscription.ts";

/**
 * HTTP implementation of {@link UpdateSubscription}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @product Billing
 * @provides Stripe.UpdateSubscription
 */
export const UpdateSubscriptionHttp = Layer.effect(
  UpdateSubscription,
  makeHttpStripeAccountBinding({
    tag: "Stripe.UpdateSubscription",
    operation: updateSubscriptionOp,
    permissions: ["subscriptions_write"],
  }),
);
