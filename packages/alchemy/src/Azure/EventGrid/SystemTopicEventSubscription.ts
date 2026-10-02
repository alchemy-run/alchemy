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

export interface SystemTopicEventSubscriptionProps extends EventSubscriptionSettings {
  /** Resource group of the system topic. Changing it replaces the subscription. */
  resourceGroup: string;
  /** Name of the parent system topic. Changing it replaces the subscription. */
  systemTopic: string;
}

export interface SystemTopicEventSubscription extends Resource<
  "Azure.EventGrid.SystemTopicEventSubscription",
  SystemTopicEventSubscriptionProps,
  EventSubscriptionAttributes & {
    /** Resource group of the system topic. */
    resourceGroup: string;
    /** Name of the parent system topic. */
    systemTopic: string;
  },
  never,
  Providers
> {}

/**
 * An event subscription on an Event Grid system topic — the recommended way
 * to route events emitted by an Azure resource (blob created, resource
 * written, secret expiring, …) to a destination.
 *
 * Event subscriptions have no tags; Alchemy records ownership in a label
 * (`alchemy:{stack}/{stage}/{id}`).
 *
 * @see https://learn.microsoft.com/azure/event-grid/create-view-manage-system-topics
 *
 * ### Subscribing to Azure Resource Events
 * **Example:** Blob-created events to a Storage queue
 * ```typescript
 * const events = yield* Azure.EventGrid.SystemTopic("files-events", {
 *   resourceGroup: group.resourceGroupName,
 *   source: account.storageAccountId,
 *   topicType: "Microsoft.Storage.StorageAccounts",
 * });
 * const uploads = yield* Azure.EventGrid.SystemTopicEventSubscription(
 *   "uploads",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     systemTopic: events.systemTopicName,
 *     destination: {
 *       endpointType: "StorageQueue",
 *       resourceId: account.storageAccountId,
 *       queueName: "uploads",
 *     },
 *     filter: {
 *       includedEventTypes: ["Microsoft.Storage.BlobCreated"],
 *       subjectBeginsWith: "/blobServices/default/containers/uploads/",
 *     },
 *   },
 * );
 * ```
 *
 * @resource
 */
export const SystemTopicEventSubscription =
  Resource<SystemTopicEventSubscription>(
    "Azure.EventGrid.SystemTopicEventSubscription",
  );

const getSubscription = (
  subscriptionId: string,
  resourceGroupName: string,
  systemTopicName: string,
  eventSubscriptionName: string,
) =>
  orUndefinedIfNotFound(
    eventgrid.GetSystemTopicEventSubscription({
      subscriptionId,
      resourceGroupName,
      systemTopicName,
      eventSubscriptionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  systemTopic: string,
  name: string,
  observed: ObservedSubscription,
): SystemTopicEventSubscription["Attributes"] => ({
  ...toSubscriptionAttrs(name, observed),
  resourceGroup,
  systemTopic,
});

export const SystemTopicEventSubscriptionProvider = () =>
  Provider.succeed(SystemTopicEventSubscription, {
    stables: [
      "eventSubscriptionName",
      "eventSubscriptionId",
      "resourceGroup",
      "systemTopic",
    ],

    // Deleted with their system topic.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.systemTopic, output.systemTopic) ||
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
      const systemTopic = output?.systemTopic ?? olds?.systemTopic;
      if (resourceGroup === undefined || systemTopic === undefined) {
        return undefined;
      }
      const name =
        output?.eventSubscriptionName ??
        olds?.name ??
        (yield* createEventGridName(id, 64));
      const observed = yield* getSubscription(
        subscriptionId,
        resourceGroup,
        systemTopic,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, systemTopic, name, observed);
      return (yield* isOwnedSubscription(id, observed))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventGrid");
      const { resourceGroup, systemTopic } = news;
      const name =
        news.name ??
        output?.eventSubscriptionName ??
        (yield* createEventGridName(id, 64));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        systemTopicName: systemTopic,
        eventSubscriptionName: name,
      };
      const desired = yield* desiredSubscription(id, news);
      const observed = yield* reconcileSubscription(
        {
          label: `system topic event subscription ${name}`,
          get: getSubscription(
            subscriptionId,
            resourceGroup,
            systemTopic,
            name,
          ),
          create: (properties) =>
            eventgrid.SystemTopicEventSubscriptionsCreateOrUpdate({
              ...where,
              properties,
            }),
          update: (patch) =>
            eventgrid.UpdateSystemTopicEventSubscription({
              ...where,
              ...patch,
            }),
          fullUrl: eventgrid
            .GetSystemTopicEventSubscriptionFullUrl(where)
            .pipe(Effect.map((result) => result.endpointUrl)),
        },
        desired,
      );
      return toAttrs(resourceGroup, systemTopic, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventgrid.DeleteSystemTopicEventSubscription({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          systemTopicName: output.systemTopic,
          eventSubscriptionName: output.eventSubscriptionName,
        }),
      );
      yield* waitUntilGone(
        `system topic event subscription ${output.eventSubscriptionName}`,
        getSubscription(
          subscriptionId,
          output.resourceGroup,
          output.systemTopic,
          output.eventSubscriptionName,
        ),
        { times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.EventGrid.SystemTopic"] },
  });
