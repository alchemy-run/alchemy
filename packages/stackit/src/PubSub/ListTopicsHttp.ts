import * as pubsub from "@distilled.cloud/stackit/pubsub";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding } from "./BindingHttp.ts";
import { ListTopics } from "./ListTopics.ts";

/**
 * HTTP implementation of {@link ListTopics}.
 *
 * @layer
 * @provides Stackit.PubSub.ListTopics
 */
export const ListTopicsHttp = Layer.effect(
  ListTopics,
  makeProjectHttpBinding({
    tag: "Stackit.PubSub.ListTopics",
    permissions: ["pubsub.topic.list"],
    operation: pubsub.listTopics,
  }),
);
