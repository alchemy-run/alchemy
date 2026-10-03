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
import type { EntityStatus } from "./Queue.ts";

export interface TopicProps {
  /** Resource group of the namespace. Changing it replaces the topic. */
  resourceGroup: string;
  /**
   * Namespace that holds the topic (`Standard` or `Premium` tier). Changing
   * it replaces the topic.
   */
  namespace: string;
  /**
   * Topic name: 1-260 letters, digits, `.`, `-`, `_`, and `/`, starting and
   * ending with a letter or digit. If omitted, a unique lowercase name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * topic.
   */
  name?: string;
  /**
   * Partition the topic across message brokers (Standard). Changing it
   * replaces the topic.
   * @default false
   */
  enablePartitioning?: boolean;
  /**
   * Hold messages in memory before persisting them (not on Premium).
   * Changing it replaces the topic.
   * @default false
   */
  enableExpress?: boolean;
  /**
   * Detect and drop duplicate messages by `MessageId`. Changing it replaces
   * the topic.
   * @default false
   */
  requiresDuplicateDetection?: boolean;
  /**
   * Preserve the order messages were sent in.
   * @default Azure's default (`true` for non-partitioned topics)
   */
  supportOrdering?: boolean;
  /**
   * Default message time-to-live as an ISO 8601 duration.
   * @default the maximum (about 29,000 years)
   */
  defaultMessageTimeToLive?: string;
  /**
   * Maximum topic size in megabytes (1024-5120 on Standard).
   * @default 1024
   */
  maxSizeInMegabytes?: number;
  /** Maximum message size in kilobytes (Premium only). */
  maxMessageSizeInKilobytes?: number;
  /**
   * Duplicate detection window as an ISO 8601 duration.
   * @default "PT10M"
   */
  duplicateDetectionHistoryTimeWindow?: string;
  /**
   * Enable server-side batched operations.
   * @default true
   */
  enableBatchedOperations?: boolean;
  /**
   * Entity status: `Active`, `Disabled`, or `SendDisabled`.
   * @default "Active"
   */
  status?: EntityStatus;
  /** Idle interval (ISO 8601, at least `PT5M`) after which the topic is deleted. */
  autoDeleteOnIdle?: string;
  /**
   * Free-form user metadata. Alchemy appends an ownership marker
   * (`[alchemy <stack>/<stage>/<id>]`) because topics have no tags.
   */
  userMetadata?: string;
}

export interface Topic extends Resource<
  "Azure.ServiceBus.Topic",
  TopicProps,
  {
    /** Name of the topic. */
    topicName: string;
    /** ARM resource ID of the topic; use it as a role-assignment scope. */
    topicId: string;
    /** Namespace that holds the topic. */
    namespaceName: string;
    /** Resource group of the namespace. */
    resourceGroup: string;
    /** Whether the topic is partitioned. */
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
 * A Service Bus topic — publish/subscribe messaging where every
 * `Subscription` receives its own copy of each matching message. Requires a
 * `Standard` or `Premium` namespace.
 *
 * Topics have no tags, so Alchemy records ownership as a
 * `[alchemy <stack>/<stage>/<id>]` marker at the end of `userMetadata`.
 * Deleting a topic deletes its subscriptions.
 *
 * @see https://learn.microsoft.com/azure/service-bus-messaging/service-bus-queues-topics-subscriptions#topics-and-subscriptions
 *
 * ### Creating a Topic
 * **Example:** Topic with one subscription
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const events = yield* Azure.ServiceBus.Topic("events", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: bus.namespaceName,
 * });
 * yield* Azure.ServiceBus.Subscription("audit", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: bus.namespaceName,
 *   topic: events.topicName,
 * });
 * ```
 *
 * **Example:** Topic with duplicate detection and a one-day TTL
 * ```typescript
 * const events = yield* Azure.ServiceBus.Topic("events", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: bus.namespaceName,
 *   requiresDuplicateDetection: true,
 *   duplicateDetectionHistoryTimeWindow: "PT1H",
 *   defaultMessageTimeToLive: "P1D",
 * });
 * ```
 *
 * @resource
 */
export const Topic = Resource<Topic>("Azure.ServiceBus.Topic");

const MUTABLE_KEYS = [
  "supportOrdering",
  "defaultMessageTimeToLive",
  "maxSizeInMegabytes",
  "maxMessageSizeInKilobytes",
  "duplicateDetectionHistoryTimeWindow",
  "enableBatchedOperations",
  "status",
  "autoDeleteOnIdle",
] as const satisfies ReadonlyArray<keyof TopicProps>;

const getTopic = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
  topicName: string,
) =>
  orUndefinedIfNotFound(
    servicebus.GetTopic({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      topicName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  namespaceName: string,
  name: string,
  topic: servicebus.GetTopicResponse,
): Topic["Attributes"] => ({
  topicName: name,
  topicId: topic.id ?? "",
  namespaceName,
  resourceGroup,
  enablePartitioning: topic.properties?.enablePartitioning ?? false,
  enableExpress: topic.properties?.enableExpress ?? false,
  requiresDuplicateDetection:
    topic.properties?.requiresDuplicateDetection ?? false,
  status: topic.properties?.status,
  userMetadata: stripMarker(topic.properties?.userMetadata),
});

export const TopicProvider = () =>
  Provider.succeed(Topic, {
    stables: ["topicName", "topicId", "namespaceName", "resourceGroup"],

    // Topics live inside a namespace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespaceName) ||
        (news.name !== undefined && !sameName(news.name, output.topicName)) ||
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
        output?.topicName ?? olds?.name ?? (yield* createEntityName(id, 260));
      const observed = yield* getTopic(
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
        news.name ?? output?.topicName ?? (yield* createEntityName(id, 260));
      const userMetadata = metadataWithMarker(
        news.userMetadata,
        yield* ownershipMarker(id),
      );
      const properties: servicebus.SBTopicPropertiesInput = {
        enablePartitioning: news.enablePartitioning,
        enableExpress: news.enableExpress,
        requiresDuplicateDetection: news.requiresDuplicateDetection,
        supportOrdering: news.supportOrdering,
        defaultMessageTimeToLive: news.defaultMessageTimeToLive,
        maxSizeInMegabytes: news.maxSizeInMegabytes,
        maxMessageSizeInKilobytes: news.maxMessageSizeInKilobytes,
        duplicateDetectionHistoryTimeWindow:
          news.duplicateDetectionHistoryTimeWindow,
        enableBatchedOperations: news.enableBatchedOperations,
        status: news.status,
        autoDeleteOnIdle: news.autoDeleteOnIdle,
        userMetadata,
      };
      const get = getTopic(subscriptionId, resourceGroup, namespace, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT is a full replace, sent only when the topic
      // is missing or an observed property differs.
      if (
        observed === undefined ||
        observed.properties?.userMetadata !== userMetadata ||
        propertiesDiffer(MUTABLE_KEYS, observed.properties, news, olds)
      ) {
        yield* servicebus.TopicsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          namespaceName: namespace,
          topicName: name,
          properties,
        });
      }

      const fresh = yield* waitForProvisioned(
        `service bus topic ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, namespace, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        servicebus.DeleteTopic({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          namespaceName: output.namespaceName,
          topicName: output.topicName,
        }),
      );
      yield* waitUntilGone(
        `service bus topic ${output.topicName}`,
        getTopic(
          subscriptionId,
          output.resourceGroup,
          output.namespaceName,
          output.topicName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.ServiceBus.Namespace"] },
  });
