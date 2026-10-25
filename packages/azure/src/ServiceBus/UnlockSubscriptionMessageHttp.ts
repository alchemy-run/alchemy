import * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Layer from "effect/Layer";
import { makeSubscriptionOperationBinding, ServiceBusGrants } from "./BindingHttp.ts";
import { UnlockSubscriptionMessage } from "./UnlockSubscriptionMessage.ts";

/**
 * Implementation of {@link UnlockSubscriptionMessage} over the distilled
 * `servicebus-messaging` `UnlockSubscriptionMessage` operation. Assigns
 * **Azure Service Bus Data Receiver**
 * (the `receive/action` data action) on the subscription only.
 *
 * @layer
 * @provides Azure.ServiceBus.UnlockSubscriptionMessage
 */
export const UnlockSubscriptionMessageHttp = Layer.effect(
  UnlockSubscriptionMessage,
  makeSubscriptionOperationBinding({
    tag: "Azure.ServiceBus.UnlockSubscriptionMessage",
    operation: messaging.UnlockSubscriptionMessage,
    roles: ServiceBusGrants.receive,
  }),
);
