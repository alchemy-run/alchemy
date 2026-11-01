import * as pubsub from "@distilled.cloud/stackit/pubsub";
import * as Layer from "effect/Layer";
import { makeSubscriptionHttpBinding } from "./BindingHttp.ts";
import { ListSubscriptionSubscribers } from "./ListSubscriptionSubscribers.ts";

/**
 * HTTP implementation of {@link ListSubscriptionSubscribers}.
 *
 * @layer
 * @provides Stackit.PubSub.ListSubscriptionSubscribers
 */
export const ListSubscriptionSubscribersHttp = Layer.effect(
  ListSubscriptionSubscribers,
  makeSubscriptionHttpBinding({
    tag: "Stackit.PubSub.ListSubscriptionSubscribers",
    permissions: ["pubsub.subscription.subscriber.list"],
    operation: pubsub.listSubscriptionSubscribers,
  }),
);
