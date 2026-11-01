import * as pubsub from "@distilled.cloud/stackit/pubsub";
import * as Layer from "effect/Layer";
import { makeTopicHttpBinding } from "./BindingHttp.ts";
import { GetTopic } from "./GetTopic.ts";

/**
 * HTTP implementation of {@link GetTopic}.
 *
 * @layer
 * @provides Stackit.PubSub.GetTopic
 */
export const GetTopicHttp = Layer.effect(
  GetTopic,
  makeTopicHttpBinding({
    tag: "Stackit.PubSub.GetTopic",
    permissions: ["pubsub.topic.get"],
    operation: pubsub.getTopic,
  }),
);
