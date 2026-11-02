import * as pubsubData from "@distilled.cloud/stackit/pubsub_data";
import * as Layer from "effect/Layer";
import { makeTopicDataHttpBinding } from "./BindingHttp.ts";
import { PurgeTopic } from "./PurgeTopic.ts";

/**
 * HTTP implementation of {@link PurgeTopic}.
 *
 * @layer
 * @provides Stackit.PubSub.PurgeTopic
 */
export const PurgeTopicHttp = Layer.effect(
  PurgeTopic,
  makeTopicDataHttpBinding({
    tag: "Stackit.PubSub.PurgeTopic",
    operation: pubsubData.purgeTopic,
  }),
);
