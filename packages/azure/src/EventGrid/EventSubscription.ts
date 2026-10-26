import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  collectAll,
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createEventGridName, sameName } from "./common.ts";
import {
  desiredSubscription,
  hasAnyOwnershipLabel,
  isOwnedSubscription,
  reconcileSubscription,
  toSubscriptionAttrs,
  type EventSubscriptionAttributes,
  type EventSubscriptionSettings,
  type ObservedSubscription,
} from "./EventSubscriptionShared.ts";

export type {
  EventSubscriptionAdvancedFilter,
  EventSubscriptionDeliveryIdentity,
  EventSubscriptionDestination,
  EventSubscriptionFilter,
} from "./EventSubscriptionShared.ts";

export interface EventSubscriptionProps extends EventSubscriptionSettings {
  /**
   * ARM ID of the event source: a custom topic (`topic.topicId`), domain,
   * domain topic, resource group, subscription, or an Azure resource.
   * Subscribing directly on an Azure resource makes Azure create a hidden
   * system topic for it.
   *
   * :::caution
   * Changing it replaces the subscription.
   * :::
   */
  scope: string;
}

export interface EventSubscription extends Resource<
  "Azure.EventGrid.EventSubscription",
  EventSubscriptionProps,
  EventSubscriptionAttributes & {
    /** ARM ID of the scope the subscription is attached to. */
    scope: string;
  },
  never,
  Providers
> {}

/**
 * An Event Grid event subscription on any scope
 * (`Microsoft.EventGrid/eventSubscriptions`): it routes the events of a
 * custom topic, a domain or domain topic, a resource group, an Azure
 * subscription, or an Azure resource to a destination such as a Storage
 * queue, a webhook, an event hub, a Service Bus queue or topic, or an Azure
 * Function.
 *
 * Use it when the source has no declared parent in your stack (a resource
 * group, an Azure subscription, a resource you do not manage). Under a
 * declared topic, prefer `TopicEventSubscription`, `DomainEventSubscription`,
 * or `SystemTopicEventSubscription`. To run your own code on events, use
 * `Azure.EventGrid.consumeEvents` in a Function. Event subscriptions have no
 * tags, so Alchemy records ownership in a label
 * (`alchemy:{stack}/{stage}/{id}`).
 *
 * :::caution[Changing `scope`, `name`, or `eventDeliverySchema` replaces the event subscription]
 * Alchemy deletes the old subscription and creates a new one. Events
 * published between the two are not delivered.
 * :::
 *
 * :::caution[Webhook destinations must answer the validation handshake]
 * Event Grid sends a `SubscriptionValidationEvent` to a `WebHook` endpoint
 * when you create the subscription, and fails the create when the endpoint
 * does not echo the validation code.
 * :::
 *
 * @see https://learn.microsoft.com/azure/event-grid/subscribe-through-portal
 *
 * ### Subscribing to a Custom Topic
 * **Example:** Deliver `Order.Created` events to a Storage queue
 * ```typescript
 * const orders = yield* Azure.EventGrid.Topic("orders");
 * const account = yield* Azure.Storage.StorageAccount("sink");
 * const inbox = yield* Azure.Storage.Queue("inbox", {
 *   storageAccount: account.storageAccountName,
 * });
 * yield* Azure.EventGrid.EventSubscription("orders-to-inbox", {
 *   scope: orders.topicId,
 *   destination: {
 *     endpointType: "StorageQueue",
 *     resourceId: account.storageAccountId,
 *     queueName: inbox.queueName,
 *   },
 *   filter: { includedEventTypes: ["Order.Created"] },
 * });
 * ```
 *
 * ### Subscribing to Azure Resources
 * **Example:** Resource writes in the stack's resource group
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app", { location: "eastus" });
 * yield* Azure.EventGrid.EventSubscription("group-writes", {
 *   scope: group.resourceGroupId,
 *   destination: { endpointType: "EventHub", resourceId: hub.eventHubId },
 *   filter: { includedEventTypes: ["Microsoft.Resources.ResourceWriteSuccess"] },
 * });
 * ```
 *
 * **Example:** New blobs in one storage account
 * ```typescript
 * yield* Azure.EventGrid.EventSubscription("new-blobs", {
 *   scope: account.storageAccountId,
 *   destination: { endpointType: "ServiceBusQueue", resourceId: queue.queueId },
 *   filter: {
 *     includedEventTypes: ["Microsoft.Storage.BlobCreated"],
 *     subjectBeginsWith: "/blobServices/default/containers/uploads/",
 *   },
 * });
 * ```
 *
 * ### Destinations
 * **Example:** Webhook with batching
 * ```typescript
 * yield* Azure.EventGrid.EventSubscription("orders-to-hook", {
 *   scope: orders.topicId,
 *   destination: {
 *     endpointType: "WebHook",
 *     endpointUrl: "https://example.com/api/events",
 *     maxEventsPerBatch: 10,
 *     preferredBatchSizeInKilobytes: 64,
 *   },
 * });
 * ```
 *
 * **Example:** A function in a function app
 * ```typescript
 * import * as Output from "alchemy/Output";
 *
 * yield* Azure.EventGrid.EventSubscription("orders-to-function", {
 *   scope: orders.topicId,
 *   destination: {
 *     endpointType: "AzureFunction",
 *     resourceId: Output.interpolate`${app.functionAppId}/functions/onOrder`,
 *   },
 * });
 * ```
 *
 * ### Filtering
 * **Example:** Orders over 100 from the EU, CloudEvents delivery
 * ```typescript
 * yield* Azure.EventGrid.EventSubscription("big-eu-orders", {
 *   scope: orders.topicId,
 *   destination: { endpointType: "ServiceBusQueue", resourceId: queue.queueId },
 *   eventDeliverySchema: "CloudEventSchemaV1_0",
 *   filter: {
 *     includedEventTypes: ["Order.Created"],
 *     advancedFilters: [
 *       { operatorType: "NumberGreaterThan", key: "data.total", value: 100 },
 *       { operatorType: "StringIn", key: "data.region", values: ["eu-west", "eu-north"] },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Retries and Dead-Lettering
 * Event Grid retries a failed delivery with backoff. After
 * `maxDeliveryAttempts` or `eventTimeToLiveInMinutes`, it writes the event to
 * the dead-letter container, or drops it when there is none.
 *
 * **Example:** Ten attempts within an hour, then dead-letter
 * ```typescript
 * const deadLetters = yield* Azure.Storage.BlobContainer("dead-letters", {
 *   storageAccount: account.storageAccountName,
 * });
 * yield* Azure.EventGrid.EventSubscription("orders-to-hook", {
 *   scope: orders.topicId,
 *   destination: { endpointType: "WebHook", endpointUrl: "https://example.com/api/events" },
 *   retryPolicy: { maxDeliveryAttempts: 10, eventTimeToLiveInMinutes: 60 },
 *   deadLetterDestination: {
 *     resourceId: account.storageAccountId,
 *     blobContainerName: deadLetters.containerName,
 *   },
 * });
 * ```
 *
 * ### Expiring a Subscription
 * **Example:** Subscription that Azure deletes at the end of the year
 * ```typescript
 * yield* Azure.EventGrid.EventSubscription("year-end-audit", {
 *   scope: orders.topicId,
 *   destination: {
 *     endpointType: "StorageQueue",
 *     resourceId: account.storageAccountId,
 *     queueName: inbox.queueName,
 *   },
 *   expirationTimeUtc: "2026-12-31T23:59:59Z",
 * });
 * ```
 *
 * ### Event Sources
 * To run your own handler, skip the event subscription: `consumeEvents`
 * creates one that pushes to your Function.
 *
 * **Example:** Handle resource-group writes in an Azure Function
 * ```typescript
 * export default class Audit extends Azure.Functions.Function<Audit>()(
 *   "Audit",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const group = yield* AppGroup;
 *     yield* Azure.EventGrid.consumeEvents(
 *       "ResourceWrites",
 *       {
 *         scope: group.resourceGroupId,
 *         includedEventTypes: ["Microsoft.Resources.ResourceWriteSuccess"],
 *       },
 *       (event) => Effect.log(`${event.eventType} ${event.subject}`),
 *     );
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(Azure.Functions.EventGridEventSource)),
 * ) {}
 * ```
 *
 * @resource
 */
export const EventSubscription = Resource<EventSubscription>("Azure.EventGrid.EventSubscription");

const getSubscription = (scope: string, eventSubscriptionName: string) =>
  orUndefinedIfNotFound(eventgrid.GetEventSubscription({ scope, eventSubscriptionName }));

/** `{scope}/providers/Microsoft.EventGrid/eventSubscriptions/{name}` → scope. */
const scopeOf = (id: string | undefined) =>
  id?.replace(/\/providers\/Microsoft\.EventGrid\/eventSubscriptions\/[^/]+$/i, "");

const toAttrs = (
  scope: string,
  name: string,
  observed: ObservedSubscription,
): EventSubscription["Attributes"] => ({
  ...toSubscriptionAttrs(name, observed),
  scope,
});

export const EventSubscriptionProvider = () =>
  Provider.succeed(EventSubscription, {
    stables: ["eventSubscriptionName", "eventSubscriptionId", "scope"],

    // Subscription- and resource-group-scoped subscriptions; those on
    // topics and other resources are deleted with their parent.
    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(eventgrid.ListEventSubscriptionGlobalBySubscription, {
        subscriptionId,
      });
      return (page.value ?? []).flatMap((sub) => {
        const scope = scopeOf(sub.id);
        return hasAnyOwnershipLabel(sub) && scope !== undefined && sub.name !== undefined
          ? [toAttrs(scope, sub.name, sub)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.scope, output.scope) ||
        (news.name !== undefined && news.name !== output.eventSubscriptionName) ||
        (news.eventDeliverySchema ?? "EventGridSchema") !== output.eventDeliverySchema
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const scope = output?.scope ?? olds?.scope;
      if (scope === undefined) return undefined;
      const name =
        output?.eventSubscriptionName ?? olds?.name ?? (yield* createEventGridName(id, 64));
      const observed = yield* getSubscription(scope, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, name, observed);
      return (yield* isOwnedSubscription(id, observed)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventGrid");
      const scope = news.scope;
      const name =
        news.name ?? output?.eventSubscriptionName ?? (yield* createEventGridName(id, 64));
      const where = { scope, eventSubscriptionName: name };
      const desired = yield* desiredSubscription(id, news);
      const observed = yield* reconcileSubscription(
        {
          label: `event subscription ${name}`,
          get: getSubscription(scope, name),
          create: (properties) =>
            eventgrid.EventSubscriptionsCreateOrUpdate({
              ...where,
              properties,
            }),
          update: (patch) => eventgrid.UpdateEventSubscription({ ...where, ...patch }),
          fullUrl: eventgrid
            .GetEventSubscriptionFullUrl(where)
            .pipe(Effect.map((result) => result.endpointUrl)),
        },
        desired,
      );
      return toAttrs(scope, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const where = {
        scope: output.scope,
        eventSubscriptionName: output.eventSubscriptionName,
      };
      yield* ignoreNotFound(eventgrid.DeleteEventSubscription(where));
      yield* waitUntilGone(
        `event subscription ${output.eventSubscriptionName}`,
        getSubscription(output.scope, output.eventSubscriptionName),
        { times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
