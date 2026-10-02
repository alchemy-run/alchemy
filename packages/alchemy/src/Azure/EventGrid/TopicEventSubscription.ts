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
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createEventGridName, sameName } from "./common.ts";
import {
  desiredSubscription,
  isOwnedSubscription,
  reconcileSubscription,
  toSubscriptionAttrs,
  type EventSubscriptionAttributes,
  type EventSubscriptionSettings,
  type ObservedSubscription,
} from "./EventSubscriptionShared.ts";

export interface TopicEventSubscriptionProps extends EventSubscriptionSettings {
  /** Resource group of the custom topic. Changing it replaces the subscription. */
  resourceGroup: string;
  /** Name of the parent custom topic. Changing it replaces the subscription. */
  topic: string;
}

export interface TopicEventSubscription extends Resource<
  "Azure.EventGrid.TopicEventSubscription",
  TopicEventSubscriptionProps,
  EventSubscriptionAttributes & {
    /** Resource group of the custom topic. */
    resourceGroup: string;
    /** Name of the parent custom topic. */
    topicName: string;
  },
  never,
  Providers
> {}

/**
 * An event subscription on an Event Grid custom topic, addressed through the
 * topic (`topics/{topic}/eventSubscriptions/{name}`). It is the same ARM
 * object that `Azure.EventGrid.EventSubscription` creates with
 * `scope: topic.topicId`.
 *
 * Event subscriptions have no tags; Alchemy records ownership in a label
 * (`alchemy:{stack}/{stage}/{id}`).
 *
 * @see https://learn.microsoft.com/azure/event-grid/custom-topics
 *
 * ### Subscribing to a Custom Topic
 * **Example:** Deliver order events to a Storage queue
 * ```typescript
 * const topic = yield* Azure.EventGrid.Topic("orders", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const toQueue = yield* Azure.EventGrid.TopicEventSubscription("orders-queue", {
 *   resourceGroup: group.resourceGroupName,
 *   topic: topic.topicName,
 *   destination: {
 *     endpointType: "StorageQueue",
 *     resourceId: account.storageAccountId,
 *     queueName: "orders",
 *   },
 *   filter: { includedEventTypes: ["Order.Created"] },
 *   retryPolicy: { maxDeliveryAttempts: 10 },
 * });
 * ```
 *
 * @resource
 */
export const TopicEventSubscription = Resource<TopicEventSubscription>(
  "Azure.EventGrid.TopicEventSubscription",
);

const getSubscription = (
  subscriptionId: string,
  resourceGroupName: string,
  topicName: string,
  eventSubscriptionName: string,
) =>
  orUndefinedIfNotFound(
    eventgrid.GetTopicEventSubscription({
      subscriptionId,
      resourceGroupName,
      topicName,
      eventSubscriptionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  topicName: string,
  name: string,
  observed: ObservedSubscription,
): TopicEventSubscription["Attributes"] => ({
  ...toSubscriptionAttrs(name, observed),
  resourceGroup,
  topicName,
});

export const TopicEventSubscriptionProvider = () =>
  Provider.succeed(TopicEventSubscription, {
    stables: [
      "eventSubscriptionName",
      "eventSubscriptionId",
      "resourceGroup",
      "topicName",
    ],

    // Deleted with their topic.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.topic, output.topicName) ||
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
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const topic = output?.topicName ?? olds?.topic;
      if (resourceGroup === undefined || topic === undefined) {
        return undefined;
      }
      const name =
        output?.eventSubscriptionName ??
        olds?.name ??
        (yield* createEventGridName(id, 64));
      const observed = yield* getSubscription(
        subscriptionId,
        resourceGroup,
        topic,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, topic, name, observed);
      return (yield* isOwnedSubscription(id, observed))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventGrid");
      const { resourceGroup, topic } = news;
      const name =
        news.name ??
        output?.eventSubscriptionName ??
        (yield* createEventGridName(id, 64));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        topicName: topic,
        eventSubscriptionName: name,
      };
      const desired = yield* desiredSubscription(id, news);
      const observed = yield* reconcileSubscription(
        {
          label: `event grid topic event subscription ${name}`,
          get: getSubscription(subscriptionId, resourceGroup, topic, name),
          create: (properties) =>
            eventgrid.TopicEventSubscriptionsCreateOrUpdate({
              ...where,
              properties,
            }),
          update: (patch) =>
            eventgrid.UpdateTopicEventSubscription({
              ...where,
              ...patch,
            }),
          fullUrl: eventgrid
            .GetTopicEventSubscriptionFullUrl(where)
            .pipe(Effect.map((result) => result.endpointUrl)),
        },
        desired,
      );
      return toAttrs(resourceGroup, topic, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventgrid.DeleteTopicEventSubscription({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          topicName: output.topicName,
          eventSubscriptionName: output.eventSubscriptionName,
        }),
      );
      yield* waitUntilGone(
        `event grid topic event subscription ${output.eventSubscriptionName}`,
        getSubscription(
          subscriptionId,
          output.resourceGroup,
          output.topicName,
          output.eventSubscriptionName,
        ),
        { times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.EventGrid.Topic"] },
  });
