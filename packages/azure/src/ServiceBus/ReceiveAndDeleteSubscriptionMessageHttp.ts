import * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Layer from "effect/Layer";
import { makeSubscriptionOperationBinding, ServiceBusGrants } from "./BindingHttp.ts";
import { ReceiveAndDeleteSubscriptionMessage } from "./ReceiveAndDeleteSubscriptionMessage.ts";

/**
 * Implementation of {@link ReceiveAndDeleteSubscriptionMessage} over the distilled
 * `servicebus-messaging` `ReceiveAndDeleteSubscriptionMessage` operation. Assigns
 * **Azure Service Bus Data Receiver**
 * (the `receive/action` data action) on the subscription only.
 *
 * @layer
 * @provides Azure.ServiceBus.ReceiveAndDeleteSubscriptionMessage
 */
export const ReceiveAndDeleteSubscriptionMessageHttp = Layer.effect(
  ReceiveAndDeleteSubscriptionMessage,
  makeSubscriptionOperationBinding({
    tag: "Azure.ServiceBus.ReceiveAndDeleteSubscriptionMessage",
    operation: messaging.ReceiveAndDeleteSubscriptionMessage,
    roles: ServiceBusGrants.receive,
  }),
);
