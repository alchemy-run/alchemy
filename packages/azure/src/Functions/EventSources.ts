import * as Output from "alchemy/Output";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BuiltInRole } from "../Authorization/RoleAssignment.ts";
import { ChangeFeedEventSource } from "../CosmosDB/ChangeFeedEventSource.ts";
import { SqlBuiltInRole, SqlRoleAssignment } from "../CosmosDB/SqlRoleAssignment.ts";
import { EventGridEventSource, type EventGridEvent } from "../EventGrid/EventGridEventSource.ts";
import { EventHubEventSource } from "../EventHub/EventHubEventSource.ts";
import { QueueEventSource as ServiceBusQueueSource } from "../ServiceBus/QueueEventSource.ts";
import type { ServiceBusMessage } from "../ServiceBus/QueueEventSource.ts";
import { SubscriptionEventSource } from "../ServiceBus/SubscriptionEventSource.ts";
import {
  BlobCreatedEventSource as StorageBlobCreatedSource,
  type BlobCreatedEvent,
} from "../Storage/BlobCreatedEventSource.ts";
import { QueueEventSource as StorageQueueSource } from "../Storage/QueueEventSource.ts";
import { Function } from "./Function.ts";
import { functionNameOf, settingSuffix, type TriggerInvocation } from "./internal.ts";

/** Azure Event Hubs Data Receiver (not in `BuiltInRole`). */
const EVENT_HUBS_DATA_RECEIVER = "a638d3c7-ab3a-418d-83e6-5f17a39d4fde";

const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const num = (value: unknown) =>
  typeof value === "number" ? value : typeof value === "string" ? Number(value) : undefined;
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** Event Grid subscription names: 3-64 letters, digits, and hyphens. */
const subscriptionNameOf = Effect.fn(function* (hostId: string, functionName: string) {
  const stack = yield* Stack;
  return `${stack.name}-${stack.stage}-${hostId}-${functionName}`
    .replace(/[^A-Za-z0-9-]+/g, "-")
    .slice(0, 64)
    .replace(/-+$/, "");
});

/** A timer invocation (`TimerInfo` from the Functions host). */
export interface TimerInvocation {
  /** Whether this run is late (the app was down when it was due). */
  isPastDue: boolean;
  /** Raw timer info (`ScheduleStatus`, `IsPastDue`). */
  timer: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

/**
 * Run `handler` on an NCRONTAB schedule (six fields, seconds first) through
 * a native `timerTrigger` function. The Functions host fires the timer, so
 * no loop runs in the program, and one instance runs each occurrence.
 *
 * ### Scheduling work
 * **Example:** Every five minutes
 * ```typescript
 * yield* Azure.Functions.schedule("cleanup", "0 *\/5 * * * *", () =>
 *   Effect.log("cleanup"),
 * );
 * ```
 *
 * **Example:** Weekdays at 09:30 UTC
 * ```typescript
 * yield* Azure.Functions.schedule("report", "0 30 9 * * 1-5", (run) =>
 *   run.isPastDue ? Effect.log("late report") : Effect.log("report"),
 * );
 * ```
 *
 * @binding
 * @category Functions
 */
export const schedule = <Req = never>(
  name: string,
  cron: string,
  handler: (invocation: TimerInvocation) => Effect.Effect<void, never, Req>,
) =>
  Effect.gen(function* () {
    const host = yield* Function;
    yield* host.trigger(
      functionNameOf("timer", name),
      { type: "timerTrigger", schedule: cron },
      (inv: TriggerInvocation) => {
        const timer = record(inv.input);
        return handler({
          isPastDue: timer.isPastDue === true || timer.IsPastDue === true,
          timer,
          metadata: inv.metadata,
        });
      },
    );
  });

/**
 * `Azure.Storage.QueueEventSource` on an Azure Function: a native
 * `queueTrigger` function with a managed-identity connection
 * (`<conn>__queueServiceUri`). Grants **Storage Queue Data Reader** and
 * **Storage Queue Data Message Processor** on the queue.
 *
 * @binding
 */
export const StorageQueueEventSource = Layer.effect(
  StorageQueueSource,
  Effect.gen(function* () {
    const host = yield* Function;
    return Effect.fn(function* (queue, props, handler) {
      const conn = `ALCHEMY_SQ_${settingSuffix(queue.LogicalId)}`;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`Allow(${host}, Azure.Functions.StorageQueueEventSource(${queue}))`({
          env: {
            [`${conn}__queueServiceUri`]: Output.interpolate`https://${queue.storageAccount}.queue.core.windows.net`,
            [`${conn}_QUEUE`]: queue.queueName,
          },
          roleAssignments: [
            { roleDefinitionId: BuiltInRole.StorageQueueDataReader, scope: queue.queueId },
            { roleDefinitionId: BuiltInRole.StorageQueueDataMessageProcessor, scope: queue.queueId },
          ],
        });
      }
      yield* host.trigger(
        props.functionName ?? functionNameOf("queue", queue.LogicalId),
        { type: "queueTrigger", queueName: `%${conn}_QUEUE%`, connection: conn },
        (inv) =>
          handler({
            body: inv.input,
            id: str(inv.metadata.Id),
            dequeueCount: num(inv.metadata.DequeueCount),
            insertionTime: str(inv.metadata.InsertionTime),
            metadata: inv.metadata,
          }),
      );
    });
  }),
);

const toBlobCreated = (input: unknown): BlobCreatedEvent => {
  const event = record(input);
  const data = record(event.data);
  const subject = str(event.subject) ?? "";
  const match = subject.match(/\/containers\/([^/]+)\/blobs\/(.+)$/);
  return {
    blobName: match?.[2] ?? "",
    containerName: match?.[1] ?? "",
    url: str(data.url) ?? "",
    contentLength: num(data.contentLength),
    contentType: str(data.contentType),
    eTag: str(data.eTag),
    eventTime: str(event.eventTime),
    event,
  };
};

/**
 * `Azure.Storage.BlobCreatedEventSource` on an Azure Function: an Event Grid
 * subscription on the container's storage account (filtered to the
 * container, `prefix`, and `suffix`) that pushes `BlobCreated` events to a
 * native `eventGridTrigger` function. Needs no data role: handlers that
 * read the blob bind `BlobContainerRead`.
 *
 * @binding
 */
export const BlobCreatedEventSource = Layer.effect(
  StorageBlobCreatedSource,
  Effect.gen(function* () {
    const host = yield* Function;
    return Effect.fn(function* (container, props, handler) {
      const functionName = props.functionName ?? functionNameOf("blob", container.LogicalId);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const subscriptionName = yield* subscriptionNameOf(host.LogicalId, functionName);
        yield* host.bind`Allow(${host}, Azure.Functions.BlobCreatedEventSource(${container}))`({
          eventSubscriptions: [
            {
              name: subscriptionName,
              // `…/storageAccounts/{account}/blobServices/default/containers/{c}` → the account.
              scope: container.containerId.pipe(
                Output.map((id) => id.replace(/\/blobServices\/.*$/i, "")),
              ),
              functionName,
              includedEventTypes: ["Microsoft.Storage.BlobCreated"],
              subjectBeginsWith: Output.interpolate`/blobServices/default/containers/${container.containerName}/blobs/${props.prefix ?? ""}`,
              subjectEndsWith: props.suffix,
            },
          ],
        });
      }
      yield* host.trigger(functionName, { type: "eventGridTrigger" }, (inv) =>
        handler(toBlobCreated(inv.input)),
      );
    });
  }),
);

const toServiceBusMessage = (inv: TriggerInvocation): ServiceBusMessage => ({
  body: inv.input,
  messageId: str(inv.metadata.MessageId),
  deliveryCount: num(inv.metadata.DeliveryCount),
  enqueuedTimeUtc: str(inv.metadata.EnqueuedTimeUtc),
  applicationProperties: record(inv.metadata.ApplicationProperties ?? inv.metadata.UserProperties),
  metadata: inv.metadata,
});

/**
 * `Azure.ServiceBus.QueueEventSource` on an Azure Function: a native
 * `serviceBusTrigger` function with a managed-identity connection
 * (`<conn>__fullyQualifiedNamespace`). Grants **Azure Service Bus Data
 * Receiver** on the queue.
 *
 * @binding
 */
export const ServiceBusQueueEventSource = Layer.effect(
  ServiceBusQueueSource,
  Effect.gen(function* () {
    const host = yield* Function;
    return Effect.fn(function* (queue, props, handler) {
      const conn = `ALCHEMY_SB_${settingSuffix(queue.LogicalId)}`;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`Allow(${host}, Azure.Functions.ServiceBusQueueEventSource(${queue}))`({
          env: {
            [`${conn}__fullyQualifiedNamespace`]: Output.interpolate`${queue.namespaceName}.servicebus.windows.net`,
            [`${conn}_QUEUE`]: queue.queueName,
          },
          roleAssignments: [
            { roleDefinitionId: BuiltInRole.ServiceBusDataReceiver, scope: queue.queueId },
          ],
        });
      }
      yield* host.trigger(
        props.functionName ?? functionNameOf("sbq", queue.LogicalId),
        { type: "serviceBusTrigger", queueName: `%${conn}_QUEUE%`, connection: conn },
        (inv) => handler(toServiceBusMessage(inv)),
      );
    });
  }),
);

/**
 * `Azure.ServiceBus.SubscriptionEventSource` on an Azure Function: a native
 * `serviceBusTrigger` function on the topic and subscription. Grants
 * **Azure Service Bus Data Receiver** on the subscription.
 *
 * @binding
 */
export const ServiceBusSubscriptionEventSource = Layer.effect(
  SubscriptionEventSource,
  Effect.gen(function* () {
    const host = yield* Function;
    return Effect.fn(function* (subscription, props, handler) {
      const conn = `ALCHEMY_SBS_${settingSuffix(subscription.LogicalId)}`;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`Allow(${host}, Azure.Functions.ServiceBusSubscriptionEventSource(${subscription}))`(
          {
            env: {
              [`${conn}__fullyQualifiedNamespace`]: Output.interpolate`${subscription.namespaceName}.servicebus.windows.net`,
              [`${conn}_TOPIC`]: subscription.topicName,
              [`${conn}_SUBSCRIPTION`]: subscription.subscriptionName,
            },
            roleAssignments: [
              {
                roleDefinitionId: BuiltInRole.ServiceBusDataReceiver,
                scope: subscription.subscriptionResourceId,
              },
            ],
          },
        );
      }
      yield* host.trigger(
        props.functionName ?? functionNameOf("sbs", subscription.LogicalId),
        {
          type: "serviceBusTrigger",
          topicName: `%${conn}_TOPIC%`,
          subscriptionName: `%${conn}_SUBSCRIPTION%`,
          connection: conn,
        },
        (inv) => handler(toServiceBusMessage(inv)),
      );
    });
  }),
);

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === undefined ? [] : [value];

/**
 * `Azure.EventHub.EventHubEventSource` on an Azure Function: a native
 * `eventHubTrigger` function (`cardinality: many`) with a managed-identity
 * connection. Grants **Azure Event Hubs Data Receiver** on the event hub.
 *
 * @binding
 */
export const EventHubEventSource_ = Layer.effect(
  EventHubEventSource,
  Effect.gen(function* () {
    const host = yield* Function;
    return Effect.fn(function* (eventHub, props, handler) {
      const conn = `ALCHEMY_EH_${settingSuffix(eventHub.LogicalId)}`;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`Allow(${host}, Azure.Functions.EventHubEventSource(${eventHub}))`({
          env: {
            [`${conn}__fullyQualifiedNamespace`]: Output.interpolate`${eventHub.namespace}.servicebus.windows.net`,
            [`${conn}_HUB`]: eventHub.eventHubName,
            [`${conn}_GROUP`]: props.consumerGroup ?? "$Default",
          },
          roleAssignments: [
            { roleDefinitionId: EVENT_HUBS_DATA_RECEIVER, scope: eventHub.eventHubId },
          ],
        });
      }
      yield* host.trigger(
        props.functionName ?? functionNameOf("eventhub", eventHub.LogicalId),
        {
          type: "eventHubTrigger",
          eventHubName: `%${conn}_HUB%`,
          consumerGroup: `%${conn}_GROUP%`,
          connection: conn,
          cardinality: "many",
        },
        (inv) =>
          handler({
            events: asArray(inv.input),
            enqueuedTimesUtc: asArray(inv.metadata.EnqueuedTimeUtcArray).map(String),
            sequenceNumbers: asArray(inv.metadata.SequenceNumberArray).map(Number),
            metadata: inv.metadata,
          }),
      );
    });
  }),
);

const toEventGridEvent = (input: unknown): EventGridEvent => {
  const event = record(input);
  return {
    id: str(event.id) ?? "",
    eventType: str(event.eventType) ?? "",
    subject: str(event.subject) ?? "",
    eventTime: str(event.eventTime) ?? "",
    topic: str(event.topic),
    data: event.data,
    dataVersion: str(event.dataVersion),
  };
};

/**
 * `Azure.EventGrid.EventGridEventSource` on an Azure Function: an Event Grid
 * subscription on `scope` that pushes to a native `eventGridTrigger`
 * function (destination type `AzureFunction`, so no webhook key is
 * involved). The subscription is created after the code is deployed.
 *
 * @binding
 */
export const EventGridEventSource_ = Layer.effect(
  EventGridEventSource,
  Effect.gen(function* () {
    const host = yield* Function;
    return Effect.fn(function* (name, props, handler) {
      const functionName = functionNameOf("eventgrid", name);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const subscriptionName = yield* subscriptionNameOf(host.LogicalId, functionName);
        yield* host.bind`Allow(${host}, Azure.Functions.EventGridEventSource(${name}))`({
          eventSubscriptions: [
            {
              name: subscriptionName,
              scope: props.scope,
              functionName,
              includedEventTypes: props.includedEventTypes,
              subjectBeginsWith: props.subjectBeginsWith,
              subjectEndsWith: props.subjectEndsWith,
            },
          ],
        });
      }
      yield* host.trigger(functionName, { type: "eventGridTrigger" }, (inv) =>
        handler(toEventGridEvent(inv.input)),
      );
    });
  }),
);

/**
 * `Azure.CosmosDB.ChangeFeedEventSource` on an Azure Function: a native
 * `cosmosDBTrigger` function with a managed-identity connection
 * (`<conn>__accountEndpoint`). Assigns the app's identity the **Cosmos DB
 * Built-in Data Contributor** data role on the account (an
 * `Azure.CosmosDB.SqlRoleAssignment`); the lease container must exist.
 *
 * @binding
 */
export const CosmosDBChangeFeedEventSource = Layer.effect(
  ChangeFeedEventSource,
  Effect.gen(function* () {
    const host = yield* Function;
    return Effect.fn(function* (container, props, handler) {
      const conn = `ALCHEMY_COSMOS_${settingSuffix(container.LogicalId)}`;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`Allow(${host}, Azure.Functions.CosmosDBChangeFeedEventSource(${container}))`(
          {
            env: {
              [`${conn}__accountEndpoint`]: Output.interpolate`https://${container.account}.documents.azure.com:443/`,
              [`${conn}_DATABASE`]: container.database,
              [`${conn}_CONTAINER`]: container.containerName,
              [`${conn}_LEASES`]: props.leases.containerName,
            },
          },
        );
        yield* SqlRoleAssignment(`${host.LogicalId}${container.LogicalId}ChangeFeedReader`, {
          resourceGroup: container.resourceGroup,
          account: container.account,
          roleDefinitionId: SqlBuiltInRole.DataContributor,
          // Covers the watched container and the lease container.
          scope: Output.interpolate`/dbs/${container.database}`,
          principalId: host.principalId.pipe(Output.map((id) => id ?? "")),
        });
      }
      yield* host.trigger(
        props.functionName ?? functionNameOf("cosmos", container.LogicalId),
        {
          type: "cosmosDBTrigger",
          connection: conn,
          databaseName: `%${conn}_DATABASE%`,
          containerName: `%${conn}_CONTAINER%`,
          leaseContainerName: `%${conn}_LEASES%`,
          createLeaseContainerIfNotExists: false,
          startFromBeginning: props.startFromBeginning ?? false,
        },
        (inv) => handler(asArray(inv.input).map(record)),
      );
    });
  }),
);

export {
  EventGridEventSource_ as EventGridEventSource,
  EventHubEventSource_ as EventHubEventSource,
};
