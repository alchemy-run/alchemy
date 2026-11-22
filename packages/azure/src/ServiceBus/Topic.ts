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
import type { EntityStatus } from "./Queue.ts";

export interface TopicProps {
  /**
   * Resource group of the namespace.
   *
   * :::caution
   * Changing it replaces the topic.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the namespace that holds the topic (`Standard` or `Premium`
   * tier).
   *
   * :::caution
   * Changing it replaces the topic.
   * :::
   */
  namespace: string;
  /**
   * Topic name: 1-260 letters, digits, `.`, `-`, `_`, and `/`, starting and
   * ending with a letter or digit. If omitted, a unique lowercase name is
   * generated from the app, stage, and logical ID.
   *
   * :::caution
   * Changing it replaces the topic.
   * :::
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Partition the topic across message brokers (Standard).
   *
   * :::caution
   * Changing it replaces the topic.
   * :::
   * @default false
   */
  enablePartitioning?: boolean;
  /**
   * Hold messages in memory before persisting them (not on Premium).
   *
   * :::caution
   * Changing it replaces the topic.
   * :::
   * @default false
   */
  enableExpress?: boolean;
  /**
   * Detect and drop duplicate messages by `MessageId` within
   * `duplicateDetectionHistoryTimeWindow`.
   *
   * :::caution
   * Changing it replaces the topic.
   * :::
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
  /**
   * Maximum message size in kilobytes, 1024-102400 (Premium only).
   * @default Azure's default (`1024` on Premium)
   */
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
  /**
   * Idle interval (ISO 8601, at least `PT5M`) after which Service Bus
   * deletes the topic.
   * @default never (Azure's maximum, about 29,000 years)
   */
  autoDeleteOnIdle?: string;
  /**
   * Free-form user metadata. Alchemy appends an ownership marker
   * (`[alchemy <stack>/<stage>/<id>]`) because topics have no tags.
   * @default only the ownership marker
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
    /** Entity status: `Active`, `Disabled`, or `SendDisabled`. */
    status: string | undefined;
    /** User metadata (ownership marker stripped). */
    userMetadata: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Service Bus topic (`Microsoft.ServiceBus/namespaces/topics`):
 * publish/subscribe messaging where every `Subscription` receives its own
 * copy of each message that matches its rules.
 *
 * Alchemy creates the topic in a namespace you declare. Bind it to a
 * runtime with `TopicWrite` to publish: the binding assigns **Azure Service
 * Bus Data Sender** on this topic only. Receivers read from a
 * `Subscription`, not from the topic. Topics have no tags, so Alchemy
 * records ownership as a `[alchemy <stack>/<stage>/<id>]` marker at the end
 * of `userMetadata`.
 *
 * :::caution[Topics need a `Standard` or `Premium` namespace]
 * A `Basic` namespace rejects the topic.
 * :::
 *
 * :::caution[Changing `name`, `namespace`, `resourceGroup`, `enablePartitioning`, `enableExpress`, or `requiresDuplicateDetection` replaces the topic]
 * Alchemy creates a new topic and deletes the old one with its
 * subscriptions and their messages.
 * :::
 *
 * @see https://learn.microsoft.com/azure/service-bus-messaging/service-bus-queues-topics-subscriptions#topics-and-subscriptions
 *
 * ### Creating a Topic
 * **Example:** Topic with two subscriptions
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus", { sku: "Standard" });
 * const events = yield* Azure.ServiceBus.Topic("events", {
 *   namespace: bus.namespaceName,
 * });
 * const audit = yield* Azure.ServiceBus.Subscription("audit", {
 *   namespace: bus.namespaceName,
 *   topic: events.topicName,
 * });
 * const notify = yield* Azure.ServiceBus.Subscription("notify", {
 *   namespace: bus.namespaceName,
 *   topic: events.topicName,
 * });
 * ```
 *
 * ### Duplicate Detection and Time to Live
 * **Example:** Drop duplicates for an hour, expire messages after a day
 * ```typescript
 * const events = yield* Azure.ServiceBus.Topic("events", {
 *   namespace: bus.namespaceName,
 *   requiresDuplicateDetection: true,
 *   duplicateDetectionHistoryTimeWindow: "PT1H",
 *   defaultMessageTimeToLive: "P1D",
 * });
 * ```
 *
 * ### Filtering per Subscription
 * Each subscription starts with a `$Default` rule that accepts every
 * message. Add a `Rule` to route messages by their properties.
 *
 * **Example:** Route `order.*` events by their label
 * ```typescript
 * const orders = yield* Azure.ServiceBus.Subscription("orders", {
 *   namespace: bus.namespaceName,
 *   topic: events.topicName,
 * });
 * yield* Azure.ServiceBus.Rule("orders-only", {
 *   namespace: bus.namespaceName,
 *   topic: events.topicName,
 *   subscription: orders.subscriptionName,
 *   sqlFilter: { sqlExpression: "sys.Label LIKE 'order.%'" },
 * });
 * ```
 *
 * ### Size and Partitioning
 * **Example:** Partitioned 5 GB topic
 * ```typescript
 * const events = yield* Azure.ServiceBus.Topic("events", {
 *   namespace: bus.namespaceName,
 *   enablePartitioning: true,
 *   maxSizeInMegabytes: 5120,
 * });
 * ```
 *
 * **Example:** Accept 10 MB messages (Premium)
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus", { sku: "Premium" });
 * const files = yield* Azure.ServiceBus.Topic("files", {
 *   namespace: bus.namespaceName,
 *   maxMessageSizeInKilobytes: 10240,
 * });
 * ```
 *
 * ### Pausing a Topic
 * **Example:** Stop accepting new messages
 * ```typescript
 * const events = yield* Azure.ServiceBus.Topic("events", {
 *   namespace: bus.namespaceName,
 *   status: "SendDisabled",
 * });
 * ```
 *
 * ### Binding to a runtime
 * `TopicWrite` assigns **Azure Service Bus Data Sender** on this topic
 * only. It works on any host: a managed-identity host (an Azure Function,
 * Web App, Container App, container group, or VM) gets the role on its
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal.
 *
 * **Example:** Publish from an Azure Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const topic = yield* Events;
 *     const events = yield* Azure.ServiceBus.TopicWrite(topic);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* events.send({ type: "order.shipped" }, { label: "order.shipped" });
 *         return HttpServerResponse.text("published", { status: 202 });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.ServiceBus.TopicWriteHttp)),
 * ) {}
 * ```
 *
 * ### Runtime Operations
 * **Example:** Publish one message with properties, or a batch
 * ```typescript
 * // init
 * const events = yield* Azure.ServiceBus.TopicWrite(topic);
 *
 * // runtime
 * yield* events.send(
 *   { orderId: "42" },
 *   { messageId: "42", label: "order.created", properties: { region: "eu" } },
 * );
 * yield* events.sendBatch([
 *   { body: { orderId: "43" }, options: { label: "order.created" } },
 *   { body: { orderId: "44" }, options: { label: "order.created" } },
 * ]);
 * ```
 *
 * ### Event Sources
 * Consume a topic through its subscriptions: each consumer gets its own
 * copy of every message.
 *
 * **Example:** Two consumers of one topic in an Azure Function
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* Azure.ServiceBus.consumeSubscriptionMessages(Audit, (message) =>
 *       Effect.log(`audit ${message.messageId}`),
 *     );
 *     yield* Azure.ServiceBus.consumeSubscriptionMessages(Notify, (message) =>
 *       Effect.log(`notify ${message.messageId}`),
 *     );
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(Azure.Functions.ServiceBusSubscriptionEventSource)),
 * ) {}
 * ```
 *
 * ### Deleting a Topic
 * Destroying the topic deletes its subscriptions, rules, and messages.
 *
 * **Example:** Keep the topic when the stack is destroyed
 * ```typescript
 * import * as RemovalPolicy from "alchemy/RemovalPolicy";
 *
 * const events = yield* Azure.ServiceBus.Topic("events", {
 *   namespace: bus.namespaceName,
 * }).pipe(RemovalPolicy.retain());
 * ```
 *
 * @resource
 */
export const Topic = GroupedResource<Topic>("Azure.ServiceBus.Topic");

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
  requiresDuplicateDetection: topic.properties?.requiresDuplicateDetection ?? false,
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
      const name = output?.topicName ?? olds?.name ?? (yield* createEntityName(id, 260));
      const observed = yield* getTopic(subscriptionId, resourceGroup, namespace, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, namespace, name, observed);
      return (yield* hasMarker(id, observed.properties?.userMetadata)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ServiceBus");
      const { resourceGroup, namespace } = news;
      const name = news.name ?? output?.topicName ?? (yield* createEntityName(id, 260));
      const userMetadata = metadataWithMarker(news.userMetadata, yield* ownershipMarker(id));
      const properties: servicebus.SBTopicPropertiesInput = {
        enablePartitioning: news.enablePartitioning,
        enableExpress: news.enableExpress,
        requiresDuplicateDetection: news.requiresDuplicateDetection,
        supportOrdering: news.supportOrdering,
        defaultMessageTimeToLive: news.defaultMessageTimeToLive,
        maxSizeInMegabytes: news.maxSizeInMegabytes,
        maxMessageSizeInKilobytes: news.maxMessageSizeInKilobytes,
        duplicateDetectionHistoryTimeWindow: news.duplicateDetectionHistoryTimeWindow,
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

      const fresh = yield* waitForProvisioned(`service bus topic ${name}`, get, () => undefined, {
        interval: "2 seconds",
        times: 15,
      });
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
        getTopic(subscriptionId, output.resourceGroup, output.namespaceName, output.topicName),
      );
    }),

    nuke: { dependsOn: ["Azure.ServiceBus.Namespace"] },
  });
