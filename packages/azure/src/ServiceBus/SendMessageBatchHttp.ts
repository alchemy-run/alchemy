import * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Layer from "effect/Layer";
import { makeEntityOperationBinding, ServiceBusGrants } from "./BindingHttp.ts";
import { SendMessageBatch } from "./SendMessageBatch.ts";

/**
 * Implementation of {@link SendMessageBatch} over the distilled
 * `servicebus-messaging` `SendMessageBatch` operation. Assigns
 * **Azure Service Bus Data Sender** (the `send/action` data action) on
 * the queue or topic only.
 *
 * @layer
 * @provides Azure.ServiceBus.SendMessageBatch
 */
export const SendMessageBatchHttp = Layer.effect(
  SendMessageBatch,
  makeEntityOperationBinding({
    tag: "Azure.ServiceBus.SendMessageBatch",
    operation: messaging.SendMessageBatch,
    roles: ServiceBusGrants.send,
  }),
);
