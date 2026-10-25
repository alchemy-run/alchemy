import * as messaging from "@distilled.cloud/azure/eventhubs-messaging";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AzureBindings from "../AzureBindings.ts";
import { eventHubAddressOf, GrantOnEventHub, onEventHub } from "./BindingHttp.ts";
import type { EventHub } from "./EventHub.ts";
import { Send, type EventHubEventOptions, type EventHubSendOptions } from "./Send.ts";

const encode = (event: string | object) =>
  typeof event === "string" ? event : JSON.stringify(event);

const contentTypeOf = (event: string | object) =>
  typeof event === "string" ? "text/plain" : "application/json";

const brokerProperties = (options?: EventHubSendOptions) =>
  options?.partitionKey !== undefined ? { partitionKey: options.partitionKey } : undefined;

/** One event's body, content type, and custom properties. */
const single = (event: string | object, options?: EventHubEventOptions) => ({
  body: encode(event),
  contentType: contentTypeOf(event),
  userProperties: options?.properties,
});

/**
 * Implementation of {@link Send} over the distilled `eventhubs-messaging`
 * data plane. Assigns **Azure Event Hubs Data Sender** on the event hub.
 *
 * @layer
 * @provides Azure.EventHub.Send
 */
export const SendHttp = Layer.effect(
  Send,
  Effect.gen(function* () {
    const grantOnEventHub = yield* GrantOnEventHub;
    // One at a time: `Effect.all` over distilled operations dies.
    const sendEvent = yield* AzureBindings.withCredentials(messaging.SendEvent);
    const sendEventBatch = yield* AzureBindings.withCredentials(messaging.SendEventBatch);
    const sendPartitionEvent = yield* AzureBindings.withCredentials(messaging.SendPartitionEvent);
    const sendPublisherEvent = yield* AzureBindings.withCredentials(messaging.SendPublisherEvent);
    return Effect.fn(function* (hub: EventHub) {
      yield* grantOnEventHub("Azure.EventHub.Send", hub);
      const address = yield* eventHubAddressOf(hub);
      const tag = `Azure.EventHub.Send(${hub.LogicalId})`;
      const event = onEventHub(`${tag}.send`, sendEvent, address);
      const batch = onEventHub(`${tag}.sendBatch`, sendEventBatch, address);
      const partition = onEventHub(`${tag}.sendToPartition`, sendPartitionEvent, address);
      const publisher = onEventHub(`${tag}.sendAsPublisher`, sendPublisherEvent, address);
      return {
        send: (body: string | object, options?: EventHubSendOptions) =>
          Effect.asVoid(
            event({ ...single(body, options), brokerProperties: brokerProperties(options) }),
          ),
        sendBatch: (events: ReadonlyArray<string | object>, options?: EventHubSendOptions) =>
          events.length === 0
            ? Effect.void
            : Effect.asVoid(
                batch({
                  events: events.map((body) => ({
                    body: encode(body),
                    userProperties: options?.properties,
                    brokerProperties: brokerProperties(options),
                  })),
                }),
              ),
        sendToPartition: (
          partitionId: string,
          body: string | object,
          options?: EventHubEventOptions,
        ) => Effect.asVoid(partition({ ...single(body, options), partitionId })),
        sendAsPublisher: (
          publisherId: string,
          body: string | object,
          options?: EventHubEventOptions,
        ) => Effect.asVoid(publisher({ ...single(body, options), publisherId })),
      };
    });
  }),
);
