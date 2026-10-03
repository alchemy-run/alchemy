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

export interface DomainTopicEventSubscriptionProps extends EventSubscriptionSettings {
  /** Resource group of the domain. Changing it replaces the subscription. */
  resourceGroup: string;
  /** Name of the parent Event Grid domain. Changing it replaces the subscription. */
  domain: string;
  /** Name of the domain topic to subscribe to. Changing it replaces the subscription. */
  domainTopic: string;
}

export interface DomainTopicEventSubscription extends Resource<
  "Azure.EventGrid.DomainTopicEventSubscription",
  DomainTopicEventSubscriptionProps,
  EventSubscriptionAttributes & {
    /** Resource group of the domain. */
    resourceGroup: string;
    /** Name of the parent domain. */
    domain: string;
    /** Name of the parent domain topic. */
    domainTopic: string;
  },
  never,
  Providers
> {}

/**
 * An event subscription on a single topic of an Event Grid domain. It
 * receives only the events published to that domain topic. It is the same
 * ARM object that `Azure.EventGrid.EventSubscription` creates with
 * `scope: domainTopic.domainTopicId`.
 *
 * Event subscriptions have no tags; Alchemy records ownership in a label
 * (`alchemy:{stack}/{stage}/{id}`).
 *
 * @see https://learn.microsoft.com/azure/event-grid/event-domains
 *
 * ### Subscribing to a Domain Topic
 * **Example:** Deliver one tenant's events to a Storage queue
 * ```typescript
 * const domain = yield* Azure.EventGrid.Domain("tenants", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const tenantA = yield* Azure.EventGrid.DomainTopic("tenant-a", {
 *   resourceGroup: group.resourceGroupName,
 *   domain: domain.domainName,
 * });
 * const audit = yield* Azure.EventGrid.DomainTopicEventSubscription("audit", {
 *   resourceGroup: group.resourceGroupName,
 *   domain: domain.domainName,
 *   domainTopic: tenantA.domainTopicName,
 *   destination: {
 *     endpointType: "StorageQueue",
 *     resourceId: account.storageAccountId,
 *     queueName: "tenant-a",
 *   },
 * });
 * ```
 *
 * **Example:** Filter by event type with a retry policy
 * ```typescript
 * const orders = yield* Azure.EventGrid.DomainTopicEventSubscription("orders", {
 *   resourceGroup: group.resourceGroupName,
 *   domain: domain.domainName,
 *   domainTopic: tenantA.domainTopicName,
 *   destination: {
 *     endpointType: "StorageQueue",
 *     resourceId: account.storageAccountId,
 *     queueName: "orders",
 *   },
 *   filter: { includedEventTypes: ["Order.Created"] },
 *   retryPolicy: { maxDeliveryAttempts: 10, eventTimeToLiveInMinutes: 60 },
 * });
 * ```
 *
 * @resource
 */
export const DomainTopicEventSubscription =
  Resource<DomainTopicEventSubscription>(
    "Azure.EventGrid.DomainTopicEventSubscription",
  );

const getSubscription = (
  subscriptionId: string,
  resourceGroupName: string,
  domainName: string,
  topicName: string,
  eventSubscriptionName: string,
) =>
  orUndefinedIfNotFound(
    eventgrid.GetDomainTopicEventSubscription({
      subscriptionId,
      resourceGroupName,
      domainName,
      topicName,
      eventSubscriptionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  domain: string,
  domainTopic: string,
  name: string,
  observed: ObservedSubscription,
): DomainTopicEventSubscription["Attributes"] => ({
  ...toSubscriptionAttrs(name, observed),
  resourceGroup,
  domain,
  domainTopic,
});

export const DomainTopicEventSubscriptionProvider = () =>
  Provider.succeed(DomainTopicEventSubscription, {
    stables: [
      "eventSubscriptionName",
      "eventSubscriptionId",
      "resourceGroup",
      "domain",
      "domainTopic",
    ],

    // Deleted with their domain topic.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.domain, output.domain) ||
        !sameName(news.domainTopic, output.domainTopic) ||
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
      const domain = output?.domain ?? olds?.domain;
      const domainTopic = output?.domainTopic ?? olds?.domainTopic;
      if (
        resourceGroup === undefined ||
        domain === undefined ||
        domainTopic === undefined
      ) {
        return undefined;
      }
      const name =
        output?.eventSubscriptionName ??
        olds?.name ??
        (yield* createEventGridName(id, 64));
      const observed = yield* getSubscription(
        subscriptionId,
        resourceGroup,
        domain,
        domainTopic,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, domain, domainTopic, name, observed);
      return (yield* isOwnedSubscription(id, observed))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventGrid");
      const { resourceGroup, domain, domainTopic } = news;
      const name =
        news.name ??
        output?.eventSubscriptionName ??
        (yield* createEventGridName(id, 64));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        domainName: domain,
        topicName: domainTopic,
        eventSubscriptionName: name,
      };
      const desired = yield* desiredSubscription(id, news);
      const observed = yield* reconcileSubscription(
        {
          label: `event grid domain topic event subscription ${name}`,
          get: getSubscription(
            subscriptionId,
            resourceGroup,
            domain,
            domainTopic,
            name,
          ),
          create: (properties) =>
            eventgrid.DomainTopicEventSubscriptionsCreateOrUpdate({
              ...where,
              properties,
            }),
          update: (patch) =>
            eventgrid.UpdateDomainTopicEventSubscription({
              ...where,
              ...patch,
            }),
          fullUrl: eventgrid
            .GetDomainTopicEventSubscriptionFullUrl(where)
            .pipe(Effect.map((result) => result.endpointUrl)),
        },
        desired,
      );
      return toAttrs(resourceGroup, domain, domainTopic, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventgrid.DeleteDomainTopicEventSubscription({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          domainName: output.domain,
          topicName: output.domainTopic,
          eventSubscriptionName: output.eventSubscriptionName,
        }),
      );
      yield* waitUntilGone(
        `event grid domain topic event subscription ${output.eventSubscriptionName}`,
        getSubscription(
          subscriptionId,
          output.resourceGroup,
          output.domain,
          output.domainTopic,
          output.eventSubscriptionName,
        ),
        { times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.EventGrid.DomainTopic"] },
  });
