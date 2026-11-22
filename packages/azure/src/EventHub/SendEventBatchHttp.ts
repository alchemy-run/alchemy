import * as messaging from "@distilled.cloud/azure/eventhubs-messaging";
import * as Layer from "effect/Layer";
import { makeEventHubOperationBinding } from "./BindingHttp.ts";
import { SendEventBatch } from "./SendEventBatch.ts";

/**
 * Implementation of {@link SendEventBatch} over the distilled
 * `eventhubs-messaging` data plane. Assigns **Azure Event Hubs Data Sender**
 * on the event hub.
 *
 * @layer
 * @provides Azure.EventHub.SendEventBatch
 */
export const SendEventBatchHttp = Layer.effect(
  SendEventBatch,
  makeEventHubOperationBinding({
    tag: "Azure.EventHub.SendEventBatch",
    operation: messaging.SendEventBatch,
  }),
);
