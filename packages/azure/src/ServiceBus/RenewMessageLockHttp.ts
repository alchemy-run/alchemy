import * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Layer from "effect/Layer";
import { makeQueueOperationBinding, ServiceBusGrants } from "./BindingHttp.ts";
import { RenewMessageLock } from "./RenewMessageLock.ts";

/**
 * Implementation of {@link RenewMessageLock} over the distilled
 * `servicebus-messaging` `RenewMessageLock` operation. Assigns
 * **Azure Service Bus Data Receiver**
 * (the `receive/action` data action) on the queue only.
 *
 * @layer
 * @provides Azure.ServiceBus.RenewMessageLock
 */
export const RenewMessageLockHttp = Layer.effect(
  RenewMessageLock,
  makeQueueOperationBinding({
    tag: "Azure.ServiceBus.RenewMessageLock",
    operation: messaging.RenewMessageLock,
    roles: ServiceBusGrants.receive,
  }),
);
