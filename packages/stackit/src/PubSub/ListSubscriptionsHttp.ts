import * as pubsub from "@distilled.cloud/stackit/pubsub";
import * as Layer from "effect/Layer";
import { makeTopicHttpBinding } from "./BindingHttp.ts";
import { ListSubscriptions } from "./ListSubscriptions.ts";

/**
 * HTTP implementation of {@link ListSubscriptions}.
 *
 * @layer
 * @provides Stackit.PubSub.ListSubscriptions
 */
export const ListSubscriptionsHttp = Layer.effect(
  ListSubscriptions,
  makeTopicHttpBinding({
    tag: "Stackit.PubSub.ListSubscriptions",
    permissions: ["pubsub.subscription.list"],
    operation: pubsub.listSubscriptions,
  }),
);
