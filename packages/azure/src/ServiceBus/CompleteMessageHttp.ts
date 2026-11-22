import * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Layer from "effect/Layer";
import { makeQueueOperationBinding, ServiceBusGrants } from "./BindingHttp.ts";
import { CompleteMessage } from "./CompleteMessage.ts";

/**
 * Implementation of {@link CompleteMessage} over the distilled
 * `servicebus-messaging` `CompleteMessage` operation. Assigns
 * **Azure Service Bus Data Receiver**
 * (the `receive/action` data action) on the queue only.
 *
 * @layer
 * @provides Azure.ServiceBus.CompleteMessage
 */
export const CompleteMessageHttp = Layer.effect(
  CompleteMessage,
  makeQueueOperationBinding({
    tag: "Azure.ServiceBus.CompleteMessage",
    operation: messaging.CompleteMessage,
    roles: ServiceBusGrants.receive,
  }),
);
