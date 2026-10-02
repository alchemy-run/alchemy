import * as servicebus from "@distilled.cloud/azure/servicebus";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
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
  /** Resource group of the namespace. Changing it replaces the queue. */
  resourceGroup: string;
  /** Namespace that holds the queue. Changing it replaces the queue. */
  namespace: string;
  /**
   * Queue name: 1-260 letters, digits, `.`, `-`, `_`, and `/`, starting and
   * ending with a letter or digit. If omitted, a unique lowercase name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * queue.
   */
  name?: string;
  /**
   * Whether the queue supports sessions (ordered, grouped delivery).
   * Changing it replaces the queue.
   * @default false
   */
  requiresSession?: boolean;
  /**
   * Partition the queue across message brokers (Basic/Standard). Changing
   * it replaces the queue.
   * @default false
   */
  enablePartitioning?: boolean;
  /**
   * Hold messages in memory before persisting them (not on Premium).
   * Changing it replaces the queue.
   * @default false
   */
  enableExpress?: boolean;
  /**
   * Detect and drop duplicate messages by `MessageId`. Changing it replaces
   * the queue.
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
  /** Maximum message size in kilobytes (Premium only). */
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
  /** Idle interval (ISO 8601, at least `PT5M`) after which the queue is deleted. */
  autoDeleteOnIdle?: string;
  /** Queue or topic (same namespace) to auto-forward messages to. */
  forwardTo?: string;
  /** Queue or topic (same namespace) to auto-forward dead-lettered messages to. */
  forwardDeadLetteredMessagesTo?: string;
  /**
   * Free-form user metadata. Alchemy appends an ownership marker
   * (`[alchemy <stack>/<stage>/<id>]`) because queues have no tags.
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
    /** Entity status. */
    status: string | undefined;
    /** User metadata (ownership marker stripped). */
    userMetadata: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Service Bus queue — point-to-point, at-least-once message delivery with
 * peek-lock, dead-lettering, sessions, and duplicate detection.
 *
 * Queues have no tags, so Alchemy records ownership as a
 * `[alchemy <stack>/<stage>/<id>]` marker at the end of `userMetadata`.
 *
 * @see https://learn.microsoft.com/azure/service-bus-messaging/service-bus-queues-topics-subscriptions
 *
 * ### Creating a Queue
 * **Example:** Basic queue
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const orders = yield* Azure.ServiceBus.Queue("orders", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: bus.namespaceName,
 * });
 * ```
 *
 * **Example:** Session-enabled queue with a short lock
 * ```typescript
 * const orders = yield* Azure.ServiceBus.Queue("orders", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: bus.namespaceName,
 *   requiresSession: true,
 *   lockDuration: "PT30S",
 *   maxDeliveryCount: 5,
 * });
 * ```
 *
 * ### Forwarding
 * **Example:** Forward dead-lettered messages to another queue
 * ```typescript
 * const poison = yield* Azure.ServiceBus.Queue("poison", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: bus.namespaceName,
 * });
 * const orders = yield* Azure.ServiceBus.Queue("orders", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: bus.namespaceName,
 *   forwardDeadLetteredMessagesTo: poison.queueName,
 * });
 * ```
 *
 * @resource
 */
export const Queue = Resource<Queue>("Azure.ServiceBus.Queue");

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
  requiresDuplicateDetection:
    queue.properties?.requiresDuplicateDetection ?? false,
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
        (news.requiresDuplicateDetection ?? false) !==
          output.requiresDuplicateDetection
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
      const name =
        output?.queueName ?? olds?.name ?? (yield* createEntityName(id, 260));
      const observed = yield* getQueue(
        subscriptionId,
        resourceGroup,
        namespace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, namespace, name, observed);
      return (yield* hasMarker(id, observed.properties?.userMetadata))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ServiceBus");
      const { resourceGroup, namespace } = news;
      const name =
        news.name ?? output?.queueName ?? (yield* createEntityName(id, 260));
      const userMetadata = metadataWithMarker(
        news.userMetadata,
        yield* ownershipMarker(id),
      );
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
        duplicateDetectionHistoryTimeWindow:
          news.duplicateDetectionHistoryTimeWindow,
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

      const fresh = yield* waitForProvisioned(
        `service bus queue ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
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
        getQueue(
          subscriptionId,
          output.resourceGroup,
          output.namespaceName,
          output.queueName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.ServiceBus.Namespace"] },
  });
