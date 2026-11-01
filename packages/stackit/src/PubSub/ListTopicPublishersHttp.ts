import * as pubsub from "@distilled.cloud/stackit/pubsub";
import * as Layer from "effect/Layer";
import { makeTopicHttpBinding } from "./BindingHttp.ts";
import { ListTopicPublishers } from "./ListTopicPublishers.ts";

/**
 * HTTP implementation of {@link ListTopicPublishers}.
 *
 * @layer
 * @provides Stackit.PubSub.ListTopicPublishers
 */
export const ListTopicPublishersHttp = Layer.effect(
  ListTopicPublishers,
  makeTopicHttpBinding({
    tag: "Stackit.PubSub.ListTopicPublishers",
    permissions: ["pubsub.topic.publisher.list"],
    operation: pubsub.listTopicPublishers,
  }),
);
