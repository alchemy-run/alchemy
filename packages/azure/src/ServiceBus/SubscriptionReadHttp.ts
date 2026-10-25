import * as Layer from "effect/Layer";
import {
  makeReceiveServiceBusSubscriptionClient,
  makeSubscriptionReceiveBinding,
  ServiceBusGrants,
} from "./BindingHttp.ts";
import { SubscriptionRead } from "./SubscriptionRead.ts";

/**
 * Implementation of {@link SubscriptionRead} over the distilled
 * `servicebus-messaging` data plane. Assigns **Azure Service Bus Data
 * Receiver** on the subscription.
 *
 * @layer
 * @provides Azure.ServiceBus.SubscriptionRead
 */
export const SubscriptionReadHttp = Layer.effect(
  SubscriptionRead,
  makeSubscriptionReceiveBinding({
    tag: "Azure.ServiceBus.SubscriptionRead",
    roles: ServiceBusGrants.receive,
    makeClient: makeReceiveServiceBusSubscriptionClient,
  }),
);
