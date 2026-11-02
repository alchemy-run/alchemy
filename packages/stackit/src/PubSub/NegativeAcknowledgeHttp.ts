import * as pubsubData from "@distilled.cloud/stackit/pubsub_data";
import * as Layer from "effect/Layer";
import { makeSubscriptionDataHttpBinding } from "./BindingHttp.ts";
import { NegativeAcknowledge } from "./NegativeAcknowledge.ts";

/**
 * HTTP implementation of {@link NegativeAcknowledge}.
 *
 * @layer
 * @provides Stackit.PubSub.NegativeAcknowledge
 */
export const NegativeAcknowledgeHttp = Layer.effect(
  NegativeAcknowledge,
  makeSubscriptionDataHttpBinding({
    tag: "Stackit.PubSub.NegativeAcknowledge",
    operation: pubsubData.nackMessages,
  }),
);
