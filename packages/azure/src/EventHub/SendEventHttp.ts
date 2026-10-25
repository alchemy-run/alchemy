import * as messaging from "@distilled.cloud/azure/eventhubs-messaging";
import * as Layer from "effect/Layer";
import { makeEventHubOperationBinding } from "./BindingHttp.ts";
import { SendEvent } from "./SendEvent.ts";

/**
 * Implementation of {@link SendEvent} over the distilled
 * `eventhubs-messaging` data plane. Assigns **Azure Event Hubs Data Sender**
 * on the event hub.
 *
 * @layer
 * @provides Azure.EventHub.SendEvent
 */
export const SendEventHttp = Layer.effect(
  SendEvent,
  makeEventHubOperationBinding({
    tag: "Azure.EventHub.SendEvent",
    operation: messaging.SendEvent,
  }),
);
