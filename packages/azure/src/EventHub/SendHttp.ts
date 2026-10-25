import * as messaging from "@distilled.cloud/azure/eventhubs-messaging";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BuiltInRole } from "../Authorization/RoleAssignment.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { EventHub } from "./EventHub.ts";
import { Send, type EventHubSendOptions } from "./Send.ts";

const encode = (event: string | object) =>
  typeof event === "string" ? event : JSON.stringify(event);

const brokerProperties = (options?: EventHubSendOptions) =>
  options?.partitionKey !== undefined ? { partitionKey: options.partitionKey } : undefined;

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
    const bind = yield* AzureBindings.Bind;
    const sendEvent = yield* AzureBindings.withCredentials(messaging.SendEvent);
    const sendEventBatch = yield* AzureBindings.withCredentials(messaging.SendEventBatch);
    return Effect.fn(function* (hub: EventHub) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`Azure.EventHub.Send(${hub})`({
          roleAssignments: [
            { roleDefinitionId: BuiltInRole.EventHubsDataSender, scope: hub.eventHubId },
          ],
        });
      }
      const namespace = yield* hub.namespace;
      const eventHubName = yield* hub.eventHubName;
      const tag = `Azure.EventHub.Send(${hub.LogicalId})`;
      return {
        send: Effect.fn(`${tag}.send`)(function* (
          event: string | object,
          options?: EventHubSendOptions,
        ) {
          const namespaceName = yield* namespace;
          const name = yield* eventHubName;
          yield* sendEvent({
            namespaceName,
            eventHubName: name,
            body: encode(event),
            contentType: typeof event === "string" ? "text/plain" : "application/json",
            brokerProperties: brokerProperties(options),
          });
        }),
        sendBatch: Effect.fn(`${tag}.sendBatch`)(function* (
          events: ReadonlyArray<string | object>,
          options?: EventHubSendOptions,
        ) {
          if (events.length === 0) return;
          const namespaceName = yield* namespace;
          const name = yield* eventHubName;
          yield* sendEventBatch({
            namespaceName,
            eventHubName: name,
            events: events.map((event) => ({
              body: encode(event),
              brokerProperties: brokerProperties(options),
            })),
          });
        }),
      };
    });
  }),
);
