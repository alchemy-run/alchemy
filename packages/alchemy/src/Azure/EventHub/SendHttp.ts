import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import {
  AzureDataRole,
  azureDataPlaneRequest,
  bindAzureHost,
  envSuffix,
} from "../Binding.ts";
import type { EventHub } from "./EventHub.ts";
import { Send, type EventHubSendOptions } from "./Send.ts";

const EVENT_HUBS_SCOPE = "https://eventhubs.azure.net/.default";

const encode = (event: string | object) =>
  typeof event === "string" ? event : JSON.stringify(event);

/**
 * HTTP implementation of {@link Send}: the Event Hubs REST send API
 * authenticated with the host's managed identity.
 *
 * @layer
 * @provides Azure.EventHub.Send
 */
export const SendHttp = Layer.effect(
  Send,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return Effect.fn(function* (hub: EventHub) {
      const suffix = envSuffix(hub.LogicalId);
      yield* bindAzureHost({
        tag: "Azure.EventHub.Send",
        resource: hub,
        env: {
          [`AZURE_EVENTHUB_NAMESPACE_${suffix}`]: hub.namespace,
          [`AZURE_EVENTHUB_NAME_${suffix}`]: hub.eventHubName,
        },
        roleAssignments: [
          {
            roleDefinitionId: AzureDataRole.EventHubsDataSender,
            scope: hub.eventHubId,
          },
        ],
      });
      const url =
        yield* Output.interpolate`https://${hub.namespace}.servicebus.windows.net/${hub.eventHubName}/messages`;
      const post = (
        body: string,
        contentType: string,
        options?: EventHubSendOptions,
      ) =>
        Effect.gen(function* () {
          yield* azureDataPlaneRequest(
            http,
            EVENT_HUBS_SCOPE,
            HttpClientRequest.post(yield* url).pipe(
              HttpClientRequest.setHeaders(
                options?.partitionKey
                  ? {
                      BrokerProperties: JSON.stringify({
                        PartitionKey: options.partitionKey,
                      }),
                    }
                  : {},
              ),
              HttpClientRequest.bodyText(body, contentType),
            ),
          );
        });
      const tag = `Azure.EventHub.Send(${hub.LogicalId})`;
      return {
        send: Effect.fn(`${tag}.send`)(function* (
          event: string | object,
          options?: EventHubSendOptions,
        ) {
          yield* post(
            encode(event),
            "application/atom+xml;type=entry;charset=utf-8",
            options,
          );
        }),
        sendBatch: Effect.fn(`${tag}.sendBatch`)(function* (
          events: ReadonlyArray<string | object>,
          options?: EventHubSendOptions,
        ) {
          if (events.length === 0) return;
          yield* post(
            JSON.stringify(
              events.map((event) => ({
                Body: encode(event),
                ...(options?.partitionKey
                  ? {
                      BrokerProperties: { PartitionKey: options.partitionKey },
                    }
                  : {}),
              })),
            ),
            "application/vnd.microsoft.servicebus.json",
          );
        }),
      };
    });
  }),
);
