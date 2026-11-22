import * as Layer from "effect/Layer";
import {
  makeEntitySendBinding,
  makeWriteServiceBusClient,
  ServiceBusGrants,
} from "./BindingHttp.ts";
import { TopicWrite } from "./TopicWrite.ts";

/**
 * Implementation of {@link TopicWrite} over the distilled
 * `servicebus-messaging` data plane. Assigns **Azure Service Bus Data
 * Sender** on the topic.
 *
 * @layer
 * @provides Azure.ServiceBus.TopicWrite
 */
export const TopicWriteHttp = Layer.effect(
  TopicWrite,
  makeEntitySendBinding({
    tag: "Azure.ServiceBus.TopicWrite",
    roles: ServiceBusGrants.send,
    makeClient: makeWriteServiceBusClient,
  }),
);
