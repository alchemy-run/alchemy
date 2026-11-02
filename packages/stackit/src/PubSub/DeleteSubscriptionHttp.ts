import * as pubsub from "@distilled.cloud/stackit/pubsub";
import * as Layer from "effect/Layer";
import { makeTopicHttpBinding } from "./BindingHttp.ts";
import { DeleteSubscription } from "./DeleteSubscription.ts";

/**
 * HTTP implementation of {@link DeleteSubscription}.
 *
 * @layer
 * @provides Stackit.PubSub.DeleteSubscription
 */
export const DeleteSubscriptionHttp = Layer.effect(
  DeleteSubscription,
  makeTopicHttpBinding({
    tag: "Stackit.PubSub.DeleteSubscription",
    permissions: ["pubsub.subscription.delete"],
    operation: pubsub.deleteSubscription,
  }),
);
