import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  requireSinglePage,
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
   * system topic for it. Changing it replaces the subscription.
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
 * An Event Grid event subscription attached to any scope: a custom topic,
 * a domain or domain topic, a resource group, a subscription, or an Azure
 * resource. It routes matching events to a destination such as a Storage
 * queue, webhook, Event Hub, Service Bus, or Azure Function.
 *
 * Event subscriptions have no tags; Alchemy records ownership in a label
 * (`alchemy:{stack}/{stage}/{id}`).
 *
 * @see https://learn.microsoft.com/azure/event-grid/subscribe-through-portal
 *
 * ### Subscribing to a Custom Topic
 * **Example:** Deliver topic events to a Storage queue
 * ```typescript
 * const topic = yield* Azure.EventGrid.Topic("orders", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const toQueue = yield* Azure.EventGrid.EventSubscription("orders-to-queue", {
 *   scope: topic.topicId,
 *   destination: {
 *     endpointType: "StorageQueue",
 *     resourceId: account.storageAccountId,
 *     queueName: "orders",
 *   },
 *   filter: { includedEventTypes: ["Order.Created"] },
 * });
 * ```
 *
 * ### Filtering and Retries
 * **Example:** Advanced filter and retry policy
 * ```typescript
 * const bigOrders = yield* Azure.EventGrid.EventSubscription("big-orders", {
 *   scope: topic.topicId,
 *   destination: {
 *     endpointType: "WebHook",
 *     endpointUrl: "https://example.com/api/events",
 *   },
 *   filter: {
 *     advancedFilters: [
 *       { operatorType: "NumberGreaterThan", key: "data.total", value: 100 },
 *     ],
 *   },
 *   retryPolicy: { maxDeliveryAttempts: 10, eventTimeToLiveInMinutes: 60 },
 * });
 * ```
 *
 * @resource
 */
export const EventSubscription = Resource<EventSubscription>(
  "Azure.EventGrid.EventSubscription",
);

const getSubscription = (scope: string, eventSubscriptionName: string) =>
  orUndefinedIfNotFound(
    eventgrid.GetEventSubscription({ scope, eventSubscriptionName }),
  );

/** `{scope}/providers/Microsoft.EventGrid/eventSubscriptions/{name}` → scope. */
const scopeOf = (id: string | undefined) =>
  id?.replace(
    /\/providers\/Microsoft\.EventGrid\/eventSubscriptions\/[^/]+$/i,
    "",
  );

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
      const page = yield* eventgrid
        .ListEventSubscriptionGlobalBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage(
              "ListEventSubscriptionGlobalBySubscription",
              page,
            ),
          ),
        );
      return (page.value ?? []).flatMap((sub) => {
        const scope = scopeOf(sub.id);
        return hasAnyOwnershipLabel(sub) &&
          scope !== undefined &&
          sub.name !== undefined
          ? [toAttrs(scope, sub.name, sub)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.scope, output.scope) ||
        (news.name !== undefined &&
          news.name !== output.eventSubscriptionName) ||
        (news.eventDeliverySchema ?? "EventGridSchema") !==
          output.eventDeliverySchema
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const scope = output?.scope ?? olds?.scope;
      if (scope === undefined) return undefined;
      const name =
        output?.eventSubscriptionName ??
        olds?.name ??
        (yield* createEventGridName(id, 64));
      const observed = yield* getSubscription(scope, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, name, observed);
      return (yield* isOwnedSubscription(id, observed))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventGrid");
      const scope = news.scope;
      const name =
        news.name ??
        output?.eventSubscriptionName ??
        (yield* createEventGridName(id, 64));
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
          update: (patch) =>
            eventgrid.UpdateEventSubscription({ ...where, ...patch }),
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
