import * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Layer from "effect/Layer";
import { makeSubscriptionOperationBinding, ServiceBusGrants } from "./BindingHttp.ts";
import { CompleteSubscriptionMessage } from "./CompleteSubscriptionMessage.ts";

/**
 * Implementation of {@link CompleteSubscriptionMessage} over the distilled
 * `servicebus-messaging` `CompleteSubscriptionMessage` operation. Assigns
 * **Azure Service Bus Data Receiver**
 * (the `receive/action` data action) on the subscription only.
 *
 * @layer
 * @provides Azure.ServiceBus.CompleteSubscriptionMessage
 */
export const CompleteSubscriptionMessageHttp = Layer.effect(
  CompleteSubscriptionMessage,
  makeSubscriptionOperationBinding({
    tag: "Azure.ServiceBus.CompleteSubscriptionMessage",
    operation: messaging.CompleteSubscriptionMessage,
    roles: ServiceBusGrants.receive,
  }),
);
