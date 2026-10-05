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
import type { Queue } from "./Queue.ts";
import { QueueSend, type ServiceBusSendOptions } from "./QueueSend.ts";

const SERVICE_BUS_SCOPE = "https://servicebus.azure.net/.default";

/**
 * HTTP implementation of {@link QueueSend}: the Service Bus REST send API
 * authenticated with the host's managed identity.
 *
 * @layer
 * @provides Azure.ServiceBus.QueueSend
 */
export const QueueSendHttp = Layer.effect(
  QueueSend,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return Effect.fn(function* (queue: Queue) {
      const suffix = envSuffix(queue.LogicalId);
      yield* bindAzureHost({
        tag: "Azure.ServiceBus.QueueSend",
        resource: queue,
        env: {
          [`AZURE_SERVICEBUS_NAMESPACE_${suffix}`]: queue.namespaceName,
          [`AZURE_SERVICEBUS_QUEUE_${suffix}`]: queue.queueName,
        },
        roleAssignments: [
          {
            roleDefinitionId: AzureDataRole.ServiceBusDataSender,
            scope: queue.queueId,
          },
        ],
      });
      const url =
        yield* Output.interpolate`https://${queue.namespaceName}.servicebus.windows.net/${queue.queueName}/messages`;
      return {
        send: Effect.fn(`Azure.ServiceBus.QueueSend(${queue.LogicalId}).send`)(
          function* (body: string | object, options?: ServiceBusSendOptions) {
            const text = typeof body === "string" ? body : JSON.stringify(body);
            const contentType =
              options?.contentType ??
              (typeof body === "string" ? "text/plain" : "application/json");
            const broker = {
              ...(options?.messageId ? { MessageId: options.messageId } : {}),
              ...(options?.sessionId ? { SessionId: options.sessionId } : {}),
              ...(options?.correlationId
                ? { CorrelationId: options.correlationId }
                : {}),
              ...(options?.label ? { Label: options.label } : {}),
              ...(options?.timeToLiveSeconds !== undefined
                ? { TimeToLive: options.timeToLiveSeconds }
                : {}),
            };
            yield* azureDataPlaneRequest(
              http,
              SERVICE_BUS_SCOPE,
              HttpClientRequest.post(yield* url).pipe(
                HttpClientRequest.setHeaders({
                  ...options?.properties,
                  ...(Object.keys(broker).length > 0
                    ? { BrokerProperties: JSON.stringify(broker) }
                    : {}),
                }),
                HttpClientRequest.bodyText(text, contentType),
              ),
            );
          },
        ),
      };
    });
  }),
);
