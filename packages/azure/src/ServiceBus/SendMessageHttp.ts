import * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Layer from "effect/Layer";
import { makeEntityOperationBinding, ServiceBusGrants } from "./BindingHttp.ts";
import { SendMessage } from "./SendMessage.ts";

/**
 * Implementation of {@link SendMessage} over the distilled
 * `servicebus-messaging` `SendMessage` operation. Assigns
 * **Azure Service Bus Data Sender** (the `send/action` data action) on
 * the queue or topic only.
 *
 * @layer
 * @provides Azure.ServiceBus.SendMessage
 */
export const SendMessageHttp = Layer.effect(
  SendMessage,
  makeEntityOperationBinding({
    tag: "Azure.ServiceBus.SendMessage",
    operation: messaging.SendMessage,
    roles: ServiceBusGrants.send,
  }),
);
