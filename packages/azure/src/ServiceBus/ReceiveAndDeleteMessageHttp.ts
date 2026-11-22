import * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Layer from "effect/Layer";
import { makeQueueOperationBinding, ServiceBusGrants } from "./BindingHttp.ts";
import { ReceiveAndDeleteMessage } from "./ReceiveAndDeleteMessage.ts";

/**
 * Implementation of {@link ReceiveAndDeleteMessage} over the distilled
 * `servicebus-messaging` `ReceiveAndDeleteMessage` operation. Assigns
 * **Azure Service Bus Data Receiver**
 * (the `receive/action` data action) on the queue only.
 *
 * @layer
 * @provides Azure.ServiceBus.ReceiveAndDeleteMessage
 */
export const ReceiveAndDeleteMessageHttp = Layer.effect(
  ReceiveAndDeleteMessage,
  makeQueueOperationBinding({
    tag: "Azure.ServiceBus.ReceiveAndDeleteMessage",
    operation: messaging.ReceiveAndDeleteMessage,
    roles: ServiceBusGrants.receive,
  }),
);
