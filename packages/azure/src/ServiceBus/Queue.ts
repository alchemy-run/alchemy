import * as servicebus from "@distilled.cloud/azure/servicebus";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  createEntityName,
  hasMarker,
  metadataWithMarker,
  ownershipMarker,
  propertiesDiffer,
  sameName,
  stripMarker,
} from "./internal.ts";

export type EntityStatus = servicebus.EntityStatus;

export interface QueueProps {
  /**
   * Resource group of the namespace.
   *
   * :::caution
   * Changing it replaces the queue.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the namespace that holds the queue (`namespace.namespaceName`).
   *
   * :::caution
   * Changing it replaces the queue.
   * :::
   */
  namespace: string;
  /**
   * Queue name: 1-260 letters, digits, `.`, `-`, `_`, and `/`, starting and
   * ending with a letter or digit. If omitted, a unique lowercase name is
   * generated from the app, stage, and logical ID.
   *
   * :::caution
   * Changing it replaces the queue.
   * :::
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Whether the queue supports sessions (ordered, grouped delivery). Every
   * sender must then set `sessionId`.
   *
   * :::caution
   * Changing it replaces the queue.
   * :::
   * @default false
   */
  requiresSession?: boolean;
  /**
   * Partition the queue across message brokers (Basic/Standard).
   *
   * :::caution
   * Changing it replaces the queue.
   * :::
   * @default false
   */
  enablePartitioning?: boolean;
  /**
   * Hold messages in memory before persisting them (not on Premium).
   *
   * :::caution
   * Changing it replaces the queue.
   * :::
   * @default false
   */
  enableExpress?: boolean;
  /**
   * Detect and drop duplicate messages by `MessageId` within
   * `duplicateDetectionHistoryTimeWindow`.
   *
   * :::caution
   * Changing it replaces the queue.
   * :::
   * @default false
   */
  requiresDuplicateDetection?: boolean;
  /**
   * Peek-lock duration as an ISO 8601 duration, at most `PT5M`.
   * @default "PT1M"
   */
  lockDuration?: string;
  /**
   * Maximum queue size in megabytes (1024-5120 on Basic/Standard).
   * @default 1024
   */
  maxSizeInMegabytes?: number;
  /**
   * Maximum message size in kilobytes, 1024-102400 (Premium only).
   * @default Azure's default (`1024` on Premium)
   */
  maxMessageSizeInKilobytes?: number;
  /**
   * Default message time-to-live as an ISO 8601 duration.
   * @default the maximum (about 29,000 years; `P14D` on Basic)
   */
  defaultMessageTimeToLive?: string;
  /**
   * Move expired messages to the dead-letter subqueue.
   * @default false
   */
  deadLetteringOnMessageExpiration?: boolean;
  /**
   * Duplicate detection window as an ISO 8601 duration.
   * @default "PT10M"
   */
  duplicateDetectionHistoryTimeWindow?: string;
  /**
   * Deliveries before a message is dead-lettered.
   * @default 10
   */
  maxDeliveryCount?: number;
  /**
   * Entity status: `Active`, `Disabled`, `SendDisabled`, or `ReceiveDisabled`.
   * @default "Active"
   */
  status?: EntityStatus;
  /**
   * Enable server-side batched operations.
   * @default true
   */
  enableBatchedOperations?: boolean;
  /**
   * Idle interval (ISO 8601, at least `PT5M`) after which Service Bus
   * deletes the queue.
   * @default never (Azure's maximum, about 29,000 years)
   */
  autoDeleteOnIdle?: string;
  /**
   * Name of a queue or topic in the same namespace to auto-forward every
   * message to.
   * @default no forwarding
   */
  forwardTo?: string;
  /**
   * Name of a queue or topic in the same namespace to auto-forward
   * dead-lettered messages to.
   * @default no forwarding
   */
  forwardDeadLetteredMessagesTo?: string;
  /**
   * Free-form user metadata. Alchemy appends an ownership marker
   * (`[alchemy <stack>/<stage>/<id>]`) because queues have no tags.
   * @default only the ownership marker
   */
  userMetadata?: string;
}

export interface Queue extends Resource<
  "Azure.ServiceBus.Queue",
  QueueProps,
  {
    /** Name of the queue. */
    queueName: string;
    /** ARM resource ID of the queue; use it as a role-assignment scope. */
    queueId: string;
    /** Namespace that holds the queue. */
    namespaceName: string;
    /** Resource group of the namespace. */
    resourceGroup: string;
    /** Whether sessions are required. */
    requiresSession: boolean;
    /** Whether the queue is partitioned. */
    enablePartitioning: boolean;
    /** Whether express mode is enabled. */
    enableExpress: boolean;
    /** Whether duplicate detection is enabled. */
    requiresDuplicateDetection: boolean;
    /** Entity status: `Active`, `Disabled`, `SendDisabled`, or `ReceiveDisabled`. */
    status: string | undefined;
    /** User metadata (ownership marker stripped). */
    userMetadata: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Service Bus queue (`Microsoft.ServiceBus/namespaces/queues`):
 * point-to-point messaging where each message goes to one receiver, with
 * peek-lock delivery, dead-lettering, sessions, and duplicate detection.
 *
 * Alchemy creates the queue in a namespace you declare. Bind it to a
 * runtime to send, receive, or both: each binding assigns **Azure Service
 * Bus Data Sender** or **Data Receiver** on this queue only. Queues have no
 * tags, so Alchemy records ownership as a `[alchemy <stack>/<stage>/<id>]`
 * marker at the end of `userMetadata`.
 *
 * :::caution[Changing `name`, `namespace`, `resourceGroup`, `requiresSession`, `enablePartitioning`, `enableExpress`, or `requiresDuplicateDetection` replaces the queue]
 * Alchemy creates a new queue and deletes the old one with every message
 * in it, dead-lettered messages included.
 * :::
 *
 * @see https://learn.microsoft.com/azure/service-bus-messaging/service-bus-queues-topics-subscriptions
 *
 * ### Creating a Queue
 * **Example:** Queue in a new namespace
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus");
 * const orders = yield* Azure.ServiceBus.Queue("orders", {
 *   namespace: bus.namespaceName,
 * });
 * ```
 *
 * **Example:** Queue with a fixed name and a 5 GB size limit
 * ```typescript
 * const orders = yield* Azure.ServiceBus.Queue("orders", {
 *   namespace: bus.namespaceName,
 *   name: "orders",
 *   maxSizeInMegabytes: 5120,
 * });
 * ```
 *
 * ### Locks, Retries, and Time to Live
 * A receiver locks a message for `lockDuration`. When it does not complete
 * the message in time, Service Bus delivers it again. After
 * `maxDeliveryCount` deliveries, the message moves to the dead-letter
 * subqueue. Durations are ISO 8601 (`PT30S`, `PT5M`, `P1D`).
 *
 * **Example:** Short lock, five attempts, one-day time to live
 * ```typescript
 * const orders = yield* Azure.ServiceBus.Queue("orders", {
 *   namespace: bus.namespaceName,
 *   lockDuration: "PT30S",
 *   maxDeliveryCount: 5,
 *   defaultMessageTimeToLive: "P1D",
 *   deadLetteringOnMessageExpiration: true,
 * });
 * ```
 *
 * ### Sessions
 * A session-enabled queue delivers the messages of one `sessionId` in
 * order, to one receiver at a time. Every sender must set `sessionId`.
 *
 * **Example:** Ordered messages per customer
 * ```typescript
 * const orders = yield* Azure.ServiceBus.Queue("orders", {
 *   namespace: bus.namespaceName,
 *   requiresSession: true,
 * });
 * // runtime, with QueueSend: yield* sender.send(order, { sessionId: order.customerId });
 * ```
 *
 * ### Duplicate Detection
 * Service Bus drops a message whose `messageId` it already received within
 * the detection window.
 *
 * **Example:** Drop duplicates for one hour
 * ```typescript
 * const payments = yield* Azure.ServiceBus.Queue("payments", {
 *   namespace: bus.namespaceName,
 *   requiresDuplicateDetection: true,
 *   duplicateDetectionHistoryTimeWindow: "PT1H",
 * });
 * // runtime, with QueueSend: yield* sender.send(payment, { messageId: payment.id });
 * ```
 *
 * ### Dead-Lettering and Forwarding
 * **Example:** Forward dead-lettered messages to a poison queue
 * ```typescript
 * const poison = yield* Azure.ServiceBus.Queue("poison", {
 *   namespace: bus.namespaceName,
 * });
 * const orders = yield* Azure.ServiceBus.Queue("orders", {
 *   namespace: bus.namespaceName,
 *   forwardDeadLetteredMessagesTo: poison.queueName,
 * });
 * ```
 *
 * **Example:** Forward every message to a topic
 * ```typescript
 * const events = yield* Azure.ServiceBus.Topic("events", {
 *   namespace: bus.namespaceName,
 * });
 * const inbox = yield* Azure.ServiceBus.Queue("inbox", {
 *   namespace: bus.namespaceName,
 *   forwardTo: events.topicName,
 * });
 * ```
 *
 * ### Pausing and Cleaning Up
 * **Example:** Stop accepting new messages but keep draining
 * ```typescript
 * const orders = yield* Azure.ServiceBus.Queue("orders", {
 *   namespace: bus.namespaceName,
 *   status: "SendDisabled",
 * });
 * ```
 *
 * **Example:** Delete a scratch queue after seven idle days
 * ```typescript
 * const scratch = yield* Azure.ServiceBus.Queue("scratch", {
 *   namespace: bus.namespaceName,
 *   autoDeleteOnIdle: "P7D",
 * });
 * ```
 *
 * ### Binding to a runtime
 * Pick the binding for the access you need. `QueueSend` and `QueueWrite`
 * assign **Azure Service Bus Data Sender**, `QueueRead` assigns **Azure
 * Service Bus Data Receiver**, and `QueueReadWrite` assigns both, on this
 * queue only. The binding works on any host: a managed-identity host (an
 * Azure Function, Web App, Container App, container group, or VM) gets the
 * role on its identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal.
 *
 * **Example:** Send from an Azure Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Orders;
 *     const orders = yield* Azure.ServiceBus.QueueSend(queue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* orders.send({ orderId: "42" }, { messageId: "42" });
 *         return HttpServerResponse.text("queued", { status: 202 });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.ServiceBus.QueueSendHttp)),
 * ) {}
 * ```
 *
 * **Example:** Receive and settle in an Azure Function
 * ```typescript
 * export default class Drain extends Azure.Functions.Function<Drain>()(
 *   "Drain",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const queue = yield* Orders;
 *     const orders = yield* Azure.ServiceBus.QueueReadWrite(queue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const message = yield* orders.receive({ timeoutSeconds: 10 });
 *         if (message === undefined) return HttpServerResponse.text("empty");
 *         yield* orders.complete(message);
 *         return HttpServerResponse.text(message.text);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.ServiceBus.QueueReadWriteHttp)),
 * ) {}
 * ```
 *
 * ### Runtime Operations
 * **Example:** Send one message or a batch
 * ```typescript
 * // init
 * const orders = yield* Azure.ServiceBus.QueueWrite(queue);
 *
 * // runtime
 * yield* orders.send({ orderId: "42" }, { messageId: "42", label: "order" });
 * yield* orders.sendBatch([
 *   { body: { orderId: "43" } },
 *   { body: "plain text", options: { timeToLiveSeconds: 600 } },
 * ]);
 * ```
 *
 * **Example:** Peek-lock, then complete, abandon, or renew
 * ```typescript
 * // init
 * const orders = yield* Azure.ServiceBus.QueueRead(queue);
 *
 * // runtime
 * const message = yield* orders.receive({ timeoutSeconds: 10 });
 * if (message !== undefined) {
 *   yield* orders.renewLock(message); // extend the lock for long work
 *   yield* handle(message.text).pipe(
 *     Effect.andThen(orders.complete(message)),
 *     Effect.catch(() => orders.abandon(message)), // deliver it again
 *   );
 * }
 * ```
 *
 * **Example:** Receive and delete in one step (at most once)
 * ```typescript
 * const message = yield* orders.receiveAndDelete();
 * ```
 *
 * ### Event Sources
 * Run a handler for every message. The host completes the message when the
 * handler succeeds and abandons it when the handler fails, so it moves to
 * the dead-letter subqueue after `maxDeliveryCount` attempts.
 *
 * **Example:** Consume a queue in an Azure Function
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* Azure.ServiceBus.consumeQueueMessages(Orders, (message) =>
 *       Effect.log(`order ${message.messageId}: ${JSON.stringify(message.body)}`),
 *     );
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(Azure.Functions.ServiceBusQueueEventSource)),
 * ) {}
 * ```
 *
 * **Example:** Consume a queue in a Container App or a Container Apps job
 * ```typescript
 * yield* Azure.ServiceBus.consumeQueueMessages(Orders, (message) =>
 *   Effect.log(message.body),
 * );
 * // Container App: Effect.provide(Azure.ContainerApps.AppServiceBusQueueEventSource)
 * // Container Apps job: Effect.provide(Azure.ContainerApps.JobServiceBusQueueEventSource)
 * ```
 *
 * ### Deleting a Queue
 * Destroying the queue deletes its messages. Deleting the namespace deletes
 * the queue too.
 *
 * **Example:** Keep the queue when the stack is destroyed
 * ```typescript
 * import * as RemovalPolicy from "alchemy/RemovalPolicy";
 *
 * const orders = yield* Azure.ServiceBus.Queue("orders", {
 *   namespace: bus.namespaceName,
 * }).pipe(RemovalPolicy.retain());
 * ```
 *
 * @resource
 */
export const Queue = GroupedResource<Queue>("Azure.ServiceBus.Queue");

const MUTABLE_KEYS = [
  "lockDuration",
  "maxSizeInMegabytes",
  "maxMessageSizeInKilobytes",
  "defaultMessageTimeToLive",
  "deadLetteringOnMessageExpiration",
  "duplicateDetectionHistoryTimeWindow",
  "maxDeliveryCount",
  "status",
  "enableBatchedOperations",
  "autoDeleteOnIdle",
  "forwardTo",
  "forwardDeadLetteredMessagesTo",
] as const satisfies ReadonlyArray<keyof QueueProps>;

const getQueue = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
  queueName: string,
) =>
  orUndefinedIfNotFound(
    servicebus.GetQueue({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      queueName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  namespaceName: string,
  name: string,
  queue: servicebus.GetQueueResponse,
): Queue["Attributes"] => ({
  queueName: name,
  queueId: queue.id ?? "",
  namespaceName,
  resourceGroup,
  requiresSession: queue.properties?.requiresSession ?? false,
  enablePartitioning: queue.properties?.enablePartitioning ?? false,
  enableExpress: queue.properties?.enableExpress ?? false,
  requiresDuplicateDetection: queue.properties?.requiresDuplicateDetection ?? false,
  status: queue.properties?.status,
  userMetadata: stripMarker(queue.properties?.userMetadata),
});

export const QueueProvider = () =>
  Provider.succeed(Queue, {
    stables: ["queueName", "queueId", "namespaceName", "resourceGroup"],

    // Queues live inside a namespace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespaceName) ||
        (news.name !== undefined && !sameName(news.name, output.queueName)) ||
        (news.requiresSession ?? false) !== output.requiresSession ||
        (news.enablePartitioning ?? false) !== output.enablePartitioning ||
        (news.enableExpress ?? false) !== output.enableExpress ||
        (news.requiresDuplicateDetection ?? false) !== output.requiresDuplicateDetection
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const namespace = output?.namespaceName ?? olds?.namespace;
      if (resourceGroup === undefined || namespace === undefined) {
        return undefined;
      }
      const name = output?.queueName ?? olds?.name ?? (yield* createEntityName(id, 260));
      const observed = yield* getQueue(subscriptionId, resourceGroup, namespace, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, namespace, name, observed);
      return (yield* hasMarker(id, observed.properties?.userMetadata)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ServiceBus");
      const { resourceGroup, namespace } = news;
      const name = news.name ?? output?.queueName ?? (yield* createEntityName(id, 260));
      const userMetadata = metadataWithMarker(news.userMetadata, yield* ownershipMarker(id));
      const properties: servicebus.SBQueuePropertiesInput = {
        requiresSession: news.requiresSession,
        enablePartitioning: news.enablePartitioning,
        enableExpress: news.enableExpress,
        requiresDuplicateDetection: news.requiresDuplicateDetection,
        lockDuration: news.lockDuration,
        maxSizeInMegabytes: news.maxSizeInMegabytes,
        maxMessageSizeInKilobytes: news.maxMessageSizeInKilobytes,
        defaultMessageTimeToLive: news.defaultMessageTimeToLive,
        deadLetteringOnMessageExpiration: news.deadLetteringOnMessageExpiration,
        duplicateDetectionHistoryTimeWindow: news.duplicateDetectionHistoryTimeWindow,
        maxDeliveryCount: news.maxDeliveryCount,
        status: news.status,
        enableBatchedOperations: news.enableBatchedOperations,
        autoDeleteOnIdle: news.autoDeleteOnIdle,
        forwardTo: news.forwardTo,
        forwardDeadLetteredMessagesTo: news.forwardDeadLetteredMessagesTo,
        userMetadata,
      };
      const get = getQueue(subscriptionId, resourceGroup, namespace, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync. The PUT is a full replace, so it is sent only when
      // the queue is missing or an observed property differs.
      if (
        observed === undefined ||
        observed.properties?.userMetadata !== userMetadata ||
        propertiesDiffer(MUTABLE_KEYS, observed.properties, news, olds)
      ) {
        yield* servicebus.QueuesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          namespaceName: namespace,
          queueName: name,
          properties,
        });
      }

      const fresh = yield* waitForProvisioned(`service bus queue ${name}`, get, () => undefined, {
        interval: "2 seconds",
        times: 15,
      });
      return toAttrs(resourceGroup, namespace, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        servicebus.DeleteQueue({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          namespaceName: output.namespaceName,
          queueName: output.queueName,
        }),
      );
      yield* waitUntilGone(
        `service bus queue ${output.queueName}`,
        getQueue(subscriptionId, output.resourceGroup, output.namespaceName, output.queueName),
      );
    }),

    nuke: { dependsOn: ["Azure.ServiceBus.Namespace"] },
  });
