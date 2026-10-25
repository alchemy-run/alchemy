import * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Layer from "effect/Layer";
import { makeSubscriptionOperationBinding, ServiceBusGrants } from "./BindingHttp.ts";
import { PeekLockSubscriptionMessage } from "./PeekLockSubscriptionMessage.ts";

/**
 * Implementation of {@link PeekLockSubscriptionMessage} over the distilled
 * `servicebus-messaging` `PeekLockSubscriptionMessage` operation. Assigns
 * **Azure Service Bus Data Receiver**
 * (the `receive/action` data action) on the subscription only.
 *
 * @layer
 * @provides Azure.ServiceBus.PeekLockSubscriptionMessage
 */
export const PeekLockSubscriptionMessageHttp = Layer.effect(
  PeekLockSubscriptionMessage,
  makeSubscriptionOperationBinding({
    tag: "Azure.ServiceBus.PeekLockSubscriptionMessage",
    operation: messaging.PeekLockSubscriptionMessage,
    roles: ServiceBusGrants.receive,
  }),
);
