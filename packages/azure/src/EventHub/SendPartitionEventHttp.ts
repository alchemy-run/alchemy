import * as messaging from "@distilled.cloud/azure/eventhubs-messaging";
import * as Layer from "effect/Layer";
import { makeEventHubOperationBinding } from "./BindingHttp.ts";
import { SendPartitionEvent } from "./SendPartitionEvent.ts";

/**
 * Implementation of {@link SendPartitionEvent} over the distilled
 * `eventhubs-messaging` data plane. Assigns **Azure Event Hubs Data Sender**
 * on the event hub.
 *
 * @layer
 * @provides Azure.EventHub.SendPartitionEvent
 */
export const SendPartitionEventHttp = Layer.effect(
  SendPartitionEvent,
  makeEventHubOperationBinding({
    tag: "Azure.EventHub.SendPartitionEvent",
    operation: messaging.SendPartitionEvent,
  }),
);
