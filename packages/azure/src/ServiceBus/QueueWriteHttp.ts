import * as Layer from "effect/Layer";
import {
  makeEntitySendBinding,
  makeWriteServiceBusClient,
  ServiceBusGrants,
} from "./BindingHttp.ts";
import { QueueWrite } from "./QueueWrite.ts";

/**
 * Implementation of {@link QueueWrite} over the distilled
 * `servicebus-messaging` data plane. Assigns **Azure Service Bus Data
 * Sender** on the queue.
 *
 * @layer
 * @provides Azure.ServiceBus.QueueWrite
 */
export const QueueWriteHttp = Layer.effect(
  QueueWrite,
  makeEntitySendBinding({
    tag: "Azure.ServiceBus.QueueWrite",
    roles: ServiceBusGrants.send,
    makeClient: makeWriteServiceBusClient,
  }),
);
