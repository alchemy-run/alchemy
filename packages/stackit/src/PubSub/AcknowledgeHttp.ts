import * as pubsubData from "@distilled.cloud/stackit/pubsub_data";
import * as Layer from "effect/Layer";
import { Acknowledge } from "./Acknowledge.ts";
import { makeSubscriptionDataHttpBinding } from "./BindingHttp.ts";

/**
 * HTTP implementation of {@link Acknowledge}.
 *
 * @layer
 * @provides Stackit.PubSub.Acknowledge
 */
export const AcknowledgeHttp = Layer.effect(
  Acknowledge,
  makeSubscriptionDataHttpBinding({
    tag: "Stackit.PubSub.Acknowledge",
    operation: pubsubData.ackMessages,
  }),
);
