import * as pubsub from "@distilled.cloud/stackit/pubsub";
import * as Layer from "effect/Layer";
import { makeTopicHttpBinding } from "./BindingHttp.ts";
import { CreateSubscription } from "./CreateSubscription.ts";

/**
 * HTTP implementation of {@link CreateSubscription}.
 *
 * @layer
 * @provides Stackit.PubSub.CreateSubscription
 */
export const CreateSubscriptionHttp = Layer.effect(
  CreateSubscription,
  makeTopicHttpBinding({
    tag: "Stackit.PubSub.CreateSubscription",
    permissions: ["pubsub.subscription.create"],
    operation: pubsub.createSubscription,
  }),
);
