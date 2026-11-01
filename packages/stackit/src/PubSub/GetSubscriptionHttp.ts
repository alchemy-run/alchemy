import * as pubsub from "@distilled.cloud/stackit/pubsub";
import * as Layer from "effect/Layer";
import { makeSubscriptionHttpBinding } from "./BindingHttp.ts";
import { GetSubscription } from "./GetSubscription.ts";

/**
 * HTTP implementation of {@link GetSubscription}.
 *
 * @layer
 * @provides Stackit.PubSub.GetSubscription
 */
export const GetSubscriptionHttp = Layer.effect(
  GetSubscription,
  makeSubscriptionHttpBinding({
    tag: "Stackit.PubSub.GetSubscription",
    permissions: ["pubsub.subscription.get"],
    operation: pubsub.getSubscription,
  }),
);
