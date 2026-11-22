import * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Layer from "effect/Layer";
import { makeSubscriptionOperationBinding, ServiceBusGrants } from "./BindingHttp.ts";
import { RenewSubscriptionMessageLock } from "./RenewSubscriptionMessageLock.ts";

/**
 * Implementation of {@link RenewSubscriptionMessageLock} over the distilled
 * `servicebus-messaging` `RenewSubscriptionMessageLock` operation. Assigns
 * **Azure Service Bus Data Receiver**
 * (the `receive/action` data action) on the subscription only.
 *
 * @layer
 * @provides Azure.ServiceBus.RenewSubscriptionMessageLock
 */
export const RenewSubscriptionMessageLockHttp = Layer.effect(
  RenewSubscriptionMessageLock,
  makeSubscriptionOperationBinding({
    tag: "Azure.ServiceBus.RenewSubscriptionMessageLock",
    operation: messaging.RenewSubscriptionMessageLock,
    roles: ServiceBusGrants.receive,
  }),
);
