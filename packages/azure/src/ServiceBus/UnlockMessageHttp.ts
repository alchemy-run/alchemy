import * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Layer from "effect/Layer";
import { makeQueueOperationBinding, ServiceBusGrants } from "./BindingHttp.ts";
import { UnlockMessage } from "./UnlockMessage.ts";

/**
 * Implementation of {@link UnlockMessage} over the distilled
 * `servicebus-messaging` `UnlockMessage` operation. Assigns
 * **Azure Service Bus Data Receiver**
 * (the `receive/action` data action) on the queue only.
 *
 * @layer
 * @provides Azure.ServiceBus.UnlockMessage
 */
export const UnlockMessageHttp = Layer.effect(
  UnlockMessage,
  makeQueueOperationBinding({
    tag: "Azure.ServiceBus.UnlockMessage",
    operation: messaging.UnlockMessage,
    roles: ServiceBusGrants.receive,
  }),
);
