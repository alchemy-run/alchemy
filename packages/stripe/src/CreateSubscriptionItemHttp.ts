import { CreateSubscriptionItem as createSubscriptionItemOp } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { CreateSubscriptionItem } from "./CreateSubscriptionItem.ts";
import { makeHttpStripeAccountBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link CreateSubscriptionItem}. Provide it on the
 * Function or Worker Effect.
 *
 * @layer
 * @product Billing
 * @provides Stripe.CreateSubscriptionItem
 */
export const CreateSubscriptionItemHttp = Layer.effect(
  CreateSubscriptionItem,
  makeHttpStripeAccountBinding({
    tag: "Stripe.CreateSubscriptionItem",
    operation: createSubscriptionItemOp,
    permissions: ["subscriptions_write"],
  }),
);
