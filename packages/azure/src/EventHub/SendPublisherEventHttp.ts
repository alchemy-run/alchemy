import * as messaging from "@distilled.cloud/azure/eventhubs-messaging";
import * as Layer from "effect/Layer";
import { makeEventHubOperationBinding } from "./BindingHttp.ts";
import { SendPublisherEvent } from "./SendPublisherEvent.ts";

/**
 * Implementation of {@link SendPublisherEvent} over the distilled
 * `eventhubs-messaging` data plane. Assigns **Azure Event Hubs Data Sender**
 * on the event hub.
 *
 * @layer
 * @provides Azure.EventHub.SendPublisherEvent
 */
export const SendPublisherEventHttp = Layer.effect(
  SendPublisherEvent,
  makeEventHubOperationBinding({
    tag: "Azure.EventHub.SendPublisherEvent",
    operation: messaging.SendPublisherEvent,
  }),
);
