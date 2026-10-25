import * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Layer from "effect/Layer";
import { makeQueueOperationBinding, ServiceBusGrants } from "./BindingHttp.ts";
import { PeekLockMessage } from "./PeekLockMessage.ts";

/**
 * Implementation of {@link PeekLockMessage} over the distilled
 * `servicebus-messaging` `PeekLockMessage` operation. Assigns
 * **Azure Service Bus Data Receiver**
 * (the `receive/action` data action) on the queue only.
 *
 * @layer
 * @provides Azure.ServiceBus.PeekLockMessage
 */
export const PeekLockMessageHttp = Layer.effect(
  PeekLockMessage,
  makeQueueOperationBinding({
    tag: "Azure.ServiceBus.PeekLockMessage",
    operation: messaging.PeekLockMessage,
    roles: ServiceBusGrants.receive,
  }),
);
