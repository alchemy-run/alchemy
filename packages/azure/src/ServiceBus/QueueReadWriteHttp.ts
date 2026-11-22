import * as Layer from "effect/Layer";
import {
  makeQueueReadWriteBinding,
  makeReceiveServiceBusQueueClient,
  makeWriteServiceBusClient,
  ServiceBusGrants,
} from "./BindingHttp.ts";
import { QueueReadWrite } from "./QueueReadWrite.ts";

/**
 * Implementation of {@link QueueReadWrite} over the distilled
 * `servicebus-messaging` data plane. Assigns **Azure Service Bus Data
 * Sender** and **Azure Service Bus Data Receiver** on the queue.
 *
 * @layer
 * @provides Azure.ServiceBus.QueueReadWrite
 */
export const QueueReadWriteHttp = Layer.effect(
  QueueReadWrite,
  makeQueueReadWriteBinding({
    tag: "Azure.ServiceBus.QueueReadWrite",
    roles: ServiceBusGrants.sendReceive,
    makeClient: (ops) => (label, send, receive) => ({
      ...makeWriteServiceBusClient(ops)(label, send),
      ...makeReceiveServiceBusQueueClient(ops)(label, receive),
    }),
  }),
);
