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

export interface SubscriptionProps {
  /** Resource group of the namespace. Changing it replaces the subscription. */
  resourceGroup: string;
  /** Namespace that holds the topic. Changing it replaces the subscription. */
  namespace: string;
  /** Topic the subscription receives from. Changing it replaces the subscription. */
  topic: string;
  /**
   * Subscription name: 1-50 letters, digits, `.`, `-`, and `_`, starting
   * and ending with a letter or digit. If omitted, a unique lowercase name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the subscription.
   */
  name?: string;
  /**
   * Whether the subscription supports sessions. Changing it replaces the
   * subscription.
   * @default false
   */
  requiresSession?: boolean;
  /**
   * Peek-lock duration as an ISO 8601 duration, at most `PT5M`.
   * @default "PT1M"
   */
  lockDuration?: string;
  /**
   * Default message time-to-live as an ISO 8601 duration.
   * @default the maximum (about 29,000 years)
   */
  defaultMessageTimeToLive?: string;
  /**
   * Dead-letter messages whose filter evaluation throws.
   * @default true
   */
  deadLetteringOnFilterEvaluationExceptions?: boolean;
  /**
   * Move expired messages to the dead-letter subqueue.
   * @default false
   */
  deadLetteringOnMessageExpiration?: boolean;
  /**
   * Deliveries before a message is dead-lettered.
   * @default 10
   */
  maxDeliveryCount?: number;
  /**
   * Entity status: `Active`, `Disabled`, or `ReceiveDisabled`.
   * @default "Active"
   */
  status?: EntityStatus;
  /**
   * Enable server-side batched operations.
   * @default true
   */
  enableBatchedOperations?: boolean;
  /** Idle interval (ISO 8601, at least `PT5M`) after which the subscription is deleted. */
  autoDeleteOnIdle?: string;
  /** Queue or topic (same namespace) to auto-forward messages to. */
  forwardTo?: string;
  /** Queue or topic (same namespace) to auto-forward dead-lettered messages to. */
  forwardDeadLetteredMessagesTo?: string;
  /**
   * Free-form user metadata. Alchemy appends an ownership marker
   * (`[alchemy <stack>/<stage>/<id>]`) because subscriptions have no tags.
   */
  userMetadata?: string;
}

export interface Subscription extends Resource<
  "Azure.ServiceBus.Subscription",
  SubscriptionProps,
  {
    /** Name of the subscription. */
    subscriptionName: string;
    /**
     * ARM resource ID of the subscription (not the Azure subscription ID);
     * use it as a role-assignment scope.
     */
    subscriptionResourceId: string;
    /** Topic the subscription receives from. */
    topicName: string;
    /** Namespace that holds the topic. */
    namespaceName: string;
    /** Resource group of the namespace. */
    resourceGroup: string;
    /** Whether sessions are required. */
    requiresSession: boolean;
    /** Entity status. */
    status: string | undefined;
    /** User metadata (ownership marker stripped). */
    userMetadata: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Service Bus topic subscription — a durable, independent queue of the
 * topic's messages. Service Bus adds a `$Default` rule that accepts every
 * message.
 *
 * Subscriptions have no tags, so Alchemy records ownership as a
 * `[alchemy <stack>/<stage>/<id>]` marker at the end of `userMetadata`.
 *
 * @see https://learn.microsoft.com/azure/service-bus-messaging/service-bus-queues-topics-subscriptions#topics-and-subscriptions
 *
 * ### Creating a Subscription
 * **Example:** Subscription on a topic
 * ```typescript
 * const events = yield* Azure.ServiceBus.Topic("events", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: bus.namespaceName,
 * });
 * const audit = yield* Azure.ServiceBus.Subscription("audit", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: bus.namespaceName,
 *   topic: events.topicName,
 *   maxDeliveryCount: 5,
 * });
 * ```
 *
 * ### Forwarding
 * **Example:** Forward a subscription into a queue
 * ```typescript
 * const inbox = yield* Azure.ServiceBus.Queue("inbox", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: bus.namespaceName,
 * });
 * yield* Azure.ServiceBus.Subscription("to-inbox", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: bus.namespaceName,
 *   topic: events.topicName,
 *   forwardTo: inbox.queueName,
 * });
 * ```
 *
 * @resource
 */
export const Subscription = Resource<Subscription>(
  "Azure.ServiceBus.Subscription",
);

const MUTABLE_KEYS = [
  "lockDuration",
  "defaultMessageTimeToLive",
  "deadLetteringOnFilterEvaluationExceptions",
  "deadLetteringOnMessageExpiration",
  "maxDeliveryCount",
  "status",
  "enableBatchedOperations",
  "autoDeleteOnIdle",
  "forwardTo",
  "forwardDeadLetteredMessagesTo",
] as const satisfies ReadonlyArray<keyof SubscriptionProps>;

const getSubscription = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
  topicName: string,
  subscriptionName: string,
) =>
  orUndefinedIfNotFound(
    servicebus
      .GetSubscription({
        subscriptionId,
        resourceGroupName,
        namespaceName,
        topicName,
        subscriptionName,
      })
      .pipe(
        // Service Bus reuses ARM's `SubscriptionNotFound` code ("Subscription
        // does not exist") for a missing topic subscription.
        Effect.catchTag("SubscriptionNotFound", () =>
          Effect.succeed(undefined),
        ),
      ),
  );

const toAttrs = (
  resourceGroup: string,
  namespaceName: string,
  topicName: string,
  name: string,
  subscription: servicebus.GetSubscriptionResponse,
): Subscription["Attributes"] => ({
  subscriptionName: name,
  subscriptionResourceId: subscription.id ?? "",
  topicName,
  namespaceName,
  resourceGroup,
  requiresSession: subscription.properties?.requiresSession ?? false,
  status: subscription.properties?.status,
  userMetadata: stripMarker(subscription.properties?.userMetadata),
});

export const SubscriptionProvider = () =>
  Provider.succeed(Subscription, {
    stables: [
      "subscriptionName",
      "subscriptionResourceId",
      "topicName",
      "namespaceName",
      "resourceGroup",
    ],

    // Subscriptions live inside a topic; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespaceName) ||
        !sameName(news.topic, output.topicName) ||
        (news.name !== undefined &&
          !sameName(news.name, output.subscriptionName)) ||
        (news.requiresSession ?? false) !== output.requiresSession
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const namespace = output?.namespaceName ?? olds?.namespace;
      const topic = output?.topicName ?? olds?.topic;
      if (
        resourceGroup === undefined ||
        namespace === undefined ||
        topic === undefined
      ) {
        return undefined;
      }
      const name =
        output?.subscriptionName ??
        olds?.name ??
        (yield* createEntityName(id, 50));
      const observed = yield* getSubscription(
        subscriptionId,
        resourceGroup,
        namespace,
        topic,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, namespace, topic, name, observed);
      return (yield* hasMarker(id, observed.properties?.userMetadata))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ServiceBus");
      const { resourceGroup, namespace, topic } = news;
      const name =
        news.name ??
        output?.subscriptionName ??
        (yield* createEntityName(id, 50));
      const userMetadata = metadataWithMarker(
        news.userMetadata,
        yield* ownershipMarker(id),
      );
      const properties: servicebus.SBSubscriptionPropertiesInput = {
        requiresSession: news.requiresSession,
        lockDuration: news.lockDuration,
        defaultMessageTimeToLive: news.defaultMessageTimeToLive,
        deadLetteringOnFilterEvaluationExceptions:
          news.deadLetteringOnFilterEvaluationExceptions,
        deadLetteringOnMessageExpiration: news.deadLetteringOnMessageExpiration,
        maxDeliveryCount: news.maxDeliveryCount,
        status: news.status,
        enableBatchedOperations: news.enableBatchedOperations,
        autoDeleteOnIdle: news.autoDeleteOnIdle,
        forwardTo: news.forwardTo,
        forwardDeadLetteredMessagesTo: news.forwardDeadLetteredMessagesTo,
        userMetadata,
      };
      const get = getSubscription(
        subscriptionId,
        resourceGroup,
        namespace,
        topic,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT is a full replace, sent only when the
      // subscription is missing or an observed property differs.
      if (
        observed === undefined ||
        observed.properties?.userMetadata !== userMetadata ||
        propertiesDiffer(MUTABLE_KEYS, observed.properties, news, olds)
      ) {
        yield* servicebus.SubscriptionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          namespaceName: namespace,
          topicName: topic,
          subscriptionName: name,
          properties,
        });
      }

      const fresh = yield* waitForProvisioned(
        `service bus subscription ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, namespace, topic, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        servicebus.DeleteSubscription({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          namespaceName: output.namespaceName,
          topicName: output.topicName,
          subscriptionName: output.subscriptionName,
        }),
      );
      yield* waitUntilGone(
        `service bus subscription ${output.subscriptionName}`,
        getSubscription(
          subscriptionId,
          output.resourceGroup,
          output.namespaceName,
          output.topicName,
          output.subscriptionName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.ServiceBus.Topic"] },
  });
