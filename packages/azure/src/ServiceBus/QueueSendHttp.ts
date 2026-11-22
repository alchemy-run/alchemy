import * as Layer from "effect/Layer";
import {
  makeEntitySendBinding,
  makeSendServiceBusClient,
  ServiceBusGrants,
} from "./BindingHttp.ts";
import { QueueSend } from "./QueueSend.ts";

/**
 * Implementation of {@link QueueSend} over the distilled
 * `servicebus-messaging` data plane. Assigns **Azure Service Bus Data
 * Sender** on the queue.
 *
 * @layer
 * @provides Azure.ServiceBus.QueueSend
 */
export const QueueSendHttp = Layer.effect(
  QueueSend,
  makeEntitySendBinding({
    tag: "Azure.ServiceBus.QueueSend",
    roles: ServiceBusGrants.send,
    makeClient: makeSendServiceBusClient,
  }),
);
