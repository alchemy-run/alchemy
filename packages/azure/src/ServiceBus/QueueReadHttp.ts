import * as Layer from "effect/Layer";
import {
  makeQueueReceiveBinding,
  makeReceiveServiceBusQueueClient,
  ServiceBusGrants,
} from "./BindingHttp.ts";
import { QueueRead } from "./QueueRead.ts";

/**
 * Implementation of {@link QueueRead} over the distilled
 * `servicebus-messaging` data plane. Assigns **Azure Service Bus Data
 * Receiver** on the queue.
 *
 * @layer
 * @provides Azure.ServiceBus.QueueRead
 */
export const QueueReadHttp = Layer.effect(
  QueueRead,
  makeQueueReceiveBinding({
    tag: "Azure.ServiceBus.QueueRead",
    roles: ServiceBusGrants.receive,
    makeClient: makeReceiveServiceBusQueueClient,
  }),
);
