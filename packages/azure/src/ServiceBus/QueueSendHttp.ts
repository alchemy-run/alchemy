import * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BuiltInRole } from "../Authorization/RoleAssignment.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { Queue } from "./Queue.ts";
import { QueueSend, type ServiceBusSendOptions } from "./QueueSend.ts";

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
  Effect.gen(function* () {
    const bind = yield* AzureBindings.Bind;
    const sendMessage = yield* AzureBindings.withCredentials(messaging.SendMessage);
    return Effect.fn(function* (queue: Queue) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`Azure.ServiceBus.QueueSend(${queue})`({
          roleAssignments: [
            { roleDefinitionId: BuiltInRole.ServiceBusDataSender, scope: queue.queueId },
          ],
        });
      }
      const namespaceName = yield* queue.namespaceName;
      const queueName = yield* queue.queueName;
      return {
        send: Effect.fn(`Azure.ServiceBus.QueueSend(${queue.LogicalId}).send`)(function* (
          body: string | object,
          options?: ServiceBusSendOptions,
        ) {
          const namespace = yield* namespaceName;
          const entityPath = yield* queueName;
          yield* sendMessage({
            namespaceName: namespace,
            entityPath,
            body: typeof body === "string" ? body : JSON.stringify(body),
            contentType:
              options?.contentType ??
              (typeof body === "string" ? "text/plain" : "application/json"),
            brokerProperties: {
              messageId: options?.messageId,
              sessionId: options?.sessionId,
              correlationId: options?.correlationId,
              label: options?.label,
              timeToLive: options?.timeToLiveSeconds,
            },
            customProperties: options?.properties,
          });
        }),
      };
    });
  }),
);
