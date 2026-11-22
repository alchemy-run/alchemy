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

export interface SubscriptionProps {
  /**
   * Resource group of the namespace.
   *
   * :::caution
   * Changing it replaces the subscription.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the namespace that holds the topic.
   *
   * :::caution
   * Changing it replaces the subscription.
   * :::
   */
  namespace: string;
  /**
   * Name of the topic the subscription receives from (`topic.topicName`).
   *
   * :::caution
   * Changing it replaces the subscription.
   * :::
   */
  topic: string;
  /**
   * Subscription name: 1-50 letters, digits, `.`, `-`, and `_`, starting
   * and ending with a letter or digit. If omitted, a unique lowercase name
   * is generated from the app, stage, and logical ID.
   *
   * :::caution
   * Changing it replaces the subscription.
   * :::
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Whether the subscription supports sessions (ordered, grouped
   * delivery). Publishers must then set `sessionId`.
   *
   * :::caution
   * Changing it replaces the subscription.
   * :::
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
  /**
   * Idle interval (ISO 8601, at least `PT5M`) after which Service Bus
   * deletes the subscription.
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
   * (`[alchemy <stack>/<stage>/<id>]`) because subscriptions have no tags.
   * @default only the ownership marker
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
    /** Entity status: `Active`, `Disabled`, or `ReceiveDisabled`. */
    status: string | undefined;
    /** User metadata (ownership marker stripped). */
    userMetadata: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Service Bus topic subscription
 * (`Microsoft.ServiceBus/namespaces/topics/subscriptions`): a durable,
 * independent queue that receives its own copy of every topic message its
 * rules match.
 *
 * Service Bus gives every new subscription a `$Default` rule that accepts
 * every message; add a `Rule` to filter. Bind the subscription to a runtime
 * with `SubscriptionRead`, or consume it with `consumeSubscriptionMessages`:
 * both assign **Azure Service Bus Data Receiver** (or Data Owner for a
 * Container Apps scaler) on this subscription only. Subscriptions have no
 * tags, so Alchemy records ownership as a `[alchemy <stack>/<stage>/<id>]`
 * marker at the end of `userMetadata`.
 *
 * :::caution[Changing `name`, `topic`, `namespace`, `resourceGroup`, or `requiresSession` replaces the subscription]
 * Alchemy creates a new subscription and deletes the old one with every
 * message in it. The new subscription only receives messages published
 * after it exists.
 * :::
 *
 * @see https://learn.microsoft.com/azure/service-bus-messaging/service-bus-queues-topics-subscriptions#topics-and-subscriptions
 *
 * ### Creating a Subscription
 * **Example:** Subscription on a topic
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus");
 * const events = yield* Azure.ServiceBus.Topic("events", {
 *   namespace: bus.namespaceName,
 * });
 * const audit = yield* Azure.ServiceBus.Subscription("audit", {
 *   namespace: bus.namespaceName,
 *   topic: events.topicName,
 * });
 * ```
 *
 * ### Locks, Retries, and Dead-Lettering
 * **Example:** Five attempts with a 30-second lock, dead-letter expired messages
 * ```typescript
 * const audit = yield* Azure.ServiceBus.Subscription("audit", {
 *   namespace: bus.namespaceName,
 *   topic: events.topicName,
 *   lockDuration: "PT30S",
 *   maxDeliveryCount: 5,
 *   defaultMessageTimeToLive: "P7D",
 *   deadLetteringOnMessageExpiration: true,
 * });
 * ```
 *
 * ### Filtering Messages
 * A message reaches the subscription when any of its rules matches.
 *
 * **Example:** Receive only EU orders
 * ```typescript
 * const euOrders = yield* Azure.ServiceBus.Subscription("eu-orders", {
 *   namespace: bus.namespaceName,
 *   topic: events.topicName,
 * });
 * yield* Azure.ServiceBus.Rule("eu-only", {
 *   namespace: bus.namespaceName,
 *   topic: events.topicName,
 *   subscription: euOrders.subscriptionName,
 *   correlationFilter: { label: "order.created", properties: { region: "eu" } },
 * });
 * ```
 *
 * ### Sessions
 * **Example:** Ordered delivery per session
 * ```typescript
 * const ordered = yield* Azure.ServiceBus.Subscription("ordered", {
 *   namespace: bus.namespaceName,
 *   topic: events.topicName,
 *   requiresSession: true,
 * });
 * // publishers set `sessionId` on every message
 * ```
 *
 * ### Forwarding
 * **Example:** Forward a subscription into a queue
 * ```typescript
 * const inbox = yield* Azure.ServiceBus.Queue("inbox", {
 *   namespace: bus.namespaceName,
 * });
 * yield* Azure.ServiceBus.Subscription("to-inbox", {
 *   namespace: bus.namespaceName,
 *   topic: events.topicName,
 *   forwardTo: inbox.queueName,
 * });
 * ```
 *
 * ### Binding to a runtime
 * `SubscriptionRead` assigns **Azure Service Bus Data Receiver** on this
 * subscription only. It works on any host: a managed-identity host (an
 * Azure Function, Web App, Container App, container group, or VM) gets the
 * role on its identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal.
 *
 * **Example:** Receive and complete from an Azure Function
 * ```typescript
 * export default class Drain extends Azure.Functions.Function<Drain>()(
 *   "Drain",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const subscription = yield* Audit;
 *     const audit = yield* Azure.ServiceBus.SubscriptionRead(subscription);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const message = yield* audit.receive({ timeoutSeconds: 10 });
 *         if (message === undefined) return HttpServerResponse.text("empty");
 *         yield* audit.complete(message);
 *         return HttpServerResponse.text(message.text);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.ServiceBus.SubscriptionReadHttp)),
 * ) {}
 * ```
 *
 * ### Runtime Operations
 * **Example:** Peek-lock, then complete, abandon, or renew
 * ```typescript
 * // init
 * const audit = yield* Azure.ServiceBus.SubscriptionRead(subscription);
 *
 * // runtime
 * const message = yield* audit.receive({ timeoutSeconds: 10 });
 * if (message !== undefined) {
 *   yield* audit.renewLock(message); // extend the lock for long work
 *   yield* handle(message.text).pipe(
 *     Effect.andThen(audit.complete(message)),
 *     Effect.catch(() => audit.abandon(message)), // deliver it again
 *   );
 * }
 * ```
 *
 * **Example:** Receive and delete in one step (at most once)
 * ```typescript
 * const message = yield* audit.receiveAndDelete();
 * ```
 *
 * ### Event Sources
 * Run a handler for every message. The host completes the message when the
 * handler succeeds and abandons it when the handler fails, so it moves to
 * the dead-letter subqueue after `maxDeliveryCount` attempts.
 *
 * **Example:** Consume a subscription in an Azure Function
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* Azure.ServiceBus.consumeSubscriptionMessages(Audit, (message) =>
 *       Effect.log(`audit ${message.messageId}: ${JSON.stringify(message.body)}`),
 *     );
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(Azure.Functions.ServiceBusSubscriptionEventSource)),
 * ) {}
 * ```
 *
 * **Example:** Consume a subscription in a Container App
 * ```typescript
 * yield* Azure.ServiceBus.consumeSubscriptionMessages(Audit, (message) =>
 *   Effect.log(message.body),
 * );
 * // Effect.provide(Azure.ContainerApps.AppServiceBusSubscriptionEventSource)
 * ```
 *
 * @resource
 */
export const Subscription = GroupedResource<Subscription>("Azure.ServiceBus.Subscription");

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
        Effect.catchTag("SubscriptionNotFound", () => Effect.succeed(undefined)),
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
        (news.name !== undefined && !sameName(news.name, output.subscriptionName)) ||
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
      if (resourceGroup === undefined || namespace === undefined || topic === undefined) {
        return undefined;
      }
      const name = output?.subscriptionName ?? olds?.name ?? (yield* createEntityName(id, 50));
      const observed = yield* getSubscription(
        subscriptionId,
        resourceGroup,
        namespace,
        topic,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, namespace, topic, name, observed);
      return (yield* hasMarker(id, observed.properties?.userMetadata)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ServiceBus");
      const { resourceGroup, namespace, topic } = news;
      const name = news.name ?? output?.subscriptionName ?? (yield* createEntityName(id, 50));
      const userMetadata = metadataWithMarker(news.userMetadata, yield* ownershipMarker(id));
      const properties: servicebus.SBSubscriptionPropertiesInput = {
        requiresSession: news.requiresSession,
        lockDuration: news.lockDuration,
        defaultMessageTimeToLive: news.defaultMessageTimeToLive,
        deadLetteringOnFilterEvaluationExceptions: news.deadLetteringOnFilterEvaluationExceptions,
        deadLetteringOnMessageExpiration: news.deadLetteringOnMessageExpiration,
        maxDeliveryCount: news.maxDeliveryCount,
        status: news.status,
        enableBatchedOperations: news.enableBatchedOperations,
        autoDeleteOnIdle: news.autoDeleteOnIdle,
        forwardTo: news.forwardTo,
        forwardDeadLetteredMessagesTo: news.forwardDeadLetteredMessagesTo,
        userMetadata,
      };
      const get = getSubscription(subscriptionId, resourceGroup, namespace, topic, name);

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
