import { ServerHost } from "alchemy/Runtime/Process";
import * as Clock from "effect/Clock";
import * as Cron from "effect/Cron";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BuiltInRole } from "../Authorization/RoleAssignment.ts";
import {
  QueueEventSource as ServiceBusQueueSource,
  type QueueEventSourceService as ServiceBusQueueEventSourceService,
  type ServiceBusMessage,
} from "../ServiceBus/QueueEventSource.ts";
import { QueueRead } from "../ServiceBus/QueueRead.ts";
import { QueueReadHttp } from "../ServiceBus/QueueReadHttp.ts";
import type {
  ReceiveServiceBusClient,
  ServiceBusLockedMessage,
} from "../ServiceBus/ServiceBusTypes.ts";
import {
  SubscriptionEventSource,
  type SubscriptionEventSourceService,
} from "../ServiceBus/SubscriptionEventSource.ts";
import { SubscriptionRead } from "../ServiceBus/SubscriptionRead.ts";
import { SubscriptionReadHttp } from "../ServiceBus/SubscriptionReadHttp.ts";
import {
  QueueEventSource as StorageQueueSource,
  type QueueEventSourceService as StorageQueueEventSourceService,
  type QueueMessage,
} from "../Storage/QueueEventSource.ts";
import { QueueReceive } from "../Storage/QueueReceive.ts";
import { QueueReceiveHttp } from "../Storage/QueueReceiveHttp.ts";
import { ContainerApp } from "./ContainerApp.ts";

/** Azure Service Bus Data Owner (not in `BuiltInRole`): KEDA reads entity counts with it. */
const SERVICE_BUS_DATA_OWNER = "090c5cfd-751d-490a-894a-3ce6f1109419";

/** KEDA rule names: lowercase letters, digits, `-`, `.`; at most 63 characters. */
const ruleNameOf = (prefix: string, logicalId: string) =>
  `${prefix}-${logicalId}`
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .slice(0, 63)
    .replace(/[-.]+$/, "");

const tryJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** Run one consumer iteration forever; a failed iteration logs and backs off. */
const consumeForever = (label: string, iteration: Effect.Effect<boolean, unknown, any>) =>
  iteration.pipe(
    // An empty poll waits before the next one; a full one polls again at once.
    Effect.flatMap((received) => (received ? Effect.void : Effect.sleep("2 seconds"))),
    Effect.catchCause((cause) =>
      Effect.logWarning(`${label} consumer iteration failed`, cause).pipe(
        Effect.andThen(Effect.sleep("5 seconds")),
      ),
    ),
    Effect.forever,
  );

/**
 * `Azure.Storage.QueueEventSource` on a Container App.
 *
 * Deploy time: adds a KEDA `azure-queue` scale rule authenticated with the
 * app's system identity (it grants **Storage Queue Data Reader** on the
 * queue for that), and binds `Storage.QueueReceive` (**Storage Queue Data
 * Message Processor** on the queue). Runtime: every replica runs a loop
 * that dequeues up to 16 messages, runs the handler for each, and deletes
 * the ones it handled. A failed handler leaves its message, which becomes
 * visible again after 60 seconds.
 *
 * @layer
 * @provides Azure.Storage.QueueEventSource
 * @category ContainerApps
 */
export const AppStorageQueueEventSource = Layer.effect(
  StorageQueueSource,
  Effect.gen(function* () {
    const host = yield* ContainerApp;
    const { run } = yield* ServerHost;
    const receiveFrom = yield* QueueReceive;
    return Effect.fn(function* (queue, _props, handler) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`Allow(${host}, Azure.ContainerApps.AppStorageQueueEventSource(${queue}))`({
          scaleRules: [
            {
              name: ruleNameOf("queue", queue.LogicalId),
              azureQueue: {
                accountName: queue.storageAccount,
                queueName: queue.queueName,
                queueLength: 5,
                identity: "system",
              },
            },
          ],
          roleAssignments: [
            { roleDefinitionId: BuiltInRole.StorageQueueDataReader, scope: queue.queueId },
          ],
        });
      }
      const client = yield* receiveFrom(queue);
      yield* run(
        consumeForever(
          `Storage queue ${queue.LogicalId}`,
          Effect.gen(function* () {
            const messages = yield* client.receive({
              maxMessages: 16,
              visibilityTimeoutSeconds: 60,
            });
            for (const message of messages) {
              const delivered: QueueMessage = {
                body: tryJson(message.text),
                id: message.messageId,
                dequeueCount: message.dequeueCount,
                insertionTime: message.insertionTime,
                metadata: { PopReceipt: message.popReceipt },
              };
              const handled = yield* handler(delivered).pipe(
                Effect.as(true),
                Effect.catchCause((cause) =>
                  Effect.logError(`queue message ${message.messageId} failed`, cause).pipe(
                    Effect.as(false),
                  ),
                ),
              );
              if (handled) yield* client.delete(message);
            }
            return messages.length > 0;
          }),
        ),
      );
    }) as StorageQueueEventSourceService;
  }),
).pipe(Layer.provide(QueueReceiveHttp));

const toServiceBusMessage = (message: ServiceBusLockedMessage): ServiceBusMessage => ({
  body: tryJson(message.text),
  messageId: message.messageId,
  deliveryCount: message.deliveryCount,
  enqueuedTimeUtc: message.enqueuedTimeUtc,
  applicationProperties: Object.fromEntries(
    Object.entries(message.headers ?? {}).flatMap(([name, value]) =>
      typeof value === "string" && value.startsWith('"') ? [[name, tryJson(value)]] : [],
    ),
  ),
  metadata: { ...message.brokerProperties, LockToken: message.lockToken },
});

/** Receive one locked message, run `handler`, complete it, or abandon it on failure. */
const serviceBusIteration = <Req>(
  label: string,
  client: ReceiveServiceBusClient,
  handler: (message: ServiceBusMessage) => Effect.Effect<void, never, Req>,
) =>
  Effect.gen(function* () {
    const message = yield* client.receive({ timeoutSeconds: 20 });
    if (message === undefined) return false;
    const handled = yield* handler(toServiceBusMessage(message)).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logError(`${label} message ${message.messageId} failed`, cause).pipe(
          Effect.as(false),
        ),
      ),
    );
    if (handled) yield* client.complete(message);
    else yield* client.abandon(message);
    return true;
  });

/**
 * `Azure.ServiceBus.QueueEventSource` on a Container App.
 *
 * Deploy time: adds a KEDA `azure-servicebus` scale rule authenticated
 * with the app's system identity, which needs **Azure Service Bus Data
 * Owner** on the queue (KEDA reads the queue's message count, a manage
 * operation), and binds `ServiceBus.QueueRead`. Runtime: every replica
 * runs a loop that peek-locks one message at a time, runs the handler,
 * and completes the message, or abandons it when the handler fails; after
 * the queue's max delivery count it moves to the dead-letter queue.
 *
 * @layer
 * @provides Azure.ServiceBus.QueueEventSource
 * @category ContainerApps
 */
export const AppServiceBusQueueEventSource = Layer.effect(
  ServiceBusQueueSource,
  Effect.gen(function* () {
    const host = yield* ContainerApp;
    const { run } = yield* ServerHost;
    const readFrom = yield* QueueRead;
    return Effect.fn(function* (queue, _props, handler) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`Allow(${host}, Azure.ContainerApps.AppServiceBusQueueEventSource(${queue}))`(
          {
            scaleRules: [
              {
                name: ruleNameOf("sbq", queue.LogicalId),
                custom: {
                  type: "azure-servicebus",
                  metadata: {
                    namespace: queue.namespaceName,
                    queueName: queue.queueName,
                    messageCount: "5",
                  },
                  identity: "system",
                },
              },
            ],
            roleAssignments: [{ roleDefinitionId: SERVICE_BUS_DATA_OWNER, scope: queue.queueId }],
          },
        );
      }
      const client = yield* readFrom(queue);
      const label = `Service Bus queue ${queue.LogicalId}`;
      yield* run(consumeForever(label, serviceBusIteration(label, client, handler)));
    }) as ServiceBusQueueEventSourceService;
  }),
).pipe(Layer.provide(QueueReadHttp));

/**
 * `Azure.ServiceBus.SubscriptionEventSource` on a Container App: the same
 * as {@link AppServiceBusQueueEventSource} for a topic subscription (KEDA
 * `azure-servicebus` rule on the topic and subscription, **Azure Service
 * Bus Data Owner** on the subscription, `ServiceBus.SubscriptionRead`).
 *
 * @layer
 * @provides Azure.ServiceBus.SubscriptionEventSource
 * @category ContainerApps
 */
export const AppServiceBusSubscriptionEventSource = Layer.effect(
  SubscriptionEventSource,
  Effect.gen(function* () {
    const host = yield* ContainerApp;
    const { run } = yield* ServerHost;
    const readFrom = yield* SubscriptionRead;
    return Effect.fn(function* (subscription, _props, handler) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`Allow(${host}, Azure.ContainerApps.AppServiceBusSubscriptionEventSource(${subscription}))`(
          {
            scaleRules: [
              {
                name: ruleNameOf("sbs", subscription.LogicalId),
                custom: {
                  type: "azure-servicebus",
                  metadata: {
                    namespace: subscription.namespaceName,
                    topicName: subscription.topicName,
                    subscriptionName: subscription.subscriptionName,
                    messageCount: "5",
                  },
                  identity: "system",
                },
              },
            ],
            roleAssignments: [
              {
                roleDefinitionId: SERVICE_BUS_DATA_OWNER,
                scope: subscription.subscriptionResourceId,
              },
            ],
          },
        );
      }
      const client = yield* readFrom(subscription);
      const label = `Service Bus subscription ${subscription.LogicalId}`;
      yield* run(consumeForever(label, serviceBusIteration(label, client, handler)));
    }) as SubscriptionEventSourceService;
  }),
).pipe(Layer.provide(SubscriptionReadHttp));

/** One scheduled run. */
export interface AppScheduledRun {
  /** When this run was due (ISO 8601, UTC). */
  scheduledTime: string;
}

/**
 * Run `handler` on a cron schedule (five fields, minutes first, UTC) in
 * the app's replicas. The app keeps at least one replica running so the
 * schedule fires, and every replica runs it: keep `maxReplicas: 1` or make
 * the handler idempotent. A failed run is logged; the next one still runs.
 *
 * For a fresh container per run, use a scheduled `ContainerApps.Job`.
 *
 * ### Scheduling work
 * **Example:** Every five minutes
 * ```typescript
 * yield* Azure.ContainerApps.appSchedule("cleanup", "*\/5 * * * *", () =>
 *   Effect.log("cleanup"),
 * );
 * ```
 *
 * **Example:** Weekdays at 09:30 UTC
 * ```typescript
 * yield* Azure.ContainerApps.appSchedule("report", "30 9 * * 1-5", (run) =>
 *   Effect.log(`report due at ${run.scheduledTime}`),
 * );
 * ```
 *
 * @binding
 * @category ContainerApps
 */
export const appSchedule = <Req = never>(
  name: string,
  cron: string,
  handler: (run: AppScheduledRun) => Effect.Effect<void, never, Req>,
) =>
  Effect.gen(function* () {
    const host = yield* ContainerApp;
    const { run } = yield* ServerHost;
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      yield* host.bind`Allow(${host}, Azure.ContainerApps.appSchedule(${name}))`({
        minReplicas: 1,
      });
    }
    const loop = Effect.gen(function* () {
      const parsed = yield* Effect.fromResult(Cron.parse(cron));
      return yield* Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const next = Cron.next(parsed, now);
        yield* Effect.sleep(Duration.millis(Math.max(0, next.getTime() - now)));
        yield* handler({ scheduledTime: next.toISOString() }).pipe(
          Effect.catchCause((cause) => Effect.logError(`schedule ${name} failed`, cause)),
        );
      }).pipe(Effect.forever);
    }).pipe(
      Effect.catchCause((cause) => Effect.logError(`schedule ${name} is invalid: ${cron}`, cause)),
    );
    // As for the event sources, the handler's requirements are runtime
    // services of the running app, not requirements of its init.
    yield* run(loop as Effect.Effect<void>);
  });
