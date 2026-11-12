import { GetSubscription } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrieveSubscription } from "./RetrieveSubscription.ts";
import { makeHttpStripeAccountBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveSubscription}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @product Billing
 * @provides Stripe.RetrieveSubscription
 */
export const RetrieveSubscriptionHttp = Layer.effect(
  RetrieveSubscription,
  makeHttpStripeAccountBinding({
    tag: "Stripe.RetrieveSubscription",
    operation: GetSubscription,
    permissions: ["subscriptions_read"],
  }),
);
