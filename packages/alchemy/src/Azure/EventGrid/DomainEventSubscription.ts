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

export interface DomainEventSubscriptionProps extends EventSubscriptionSettings {
  /** Resource group of the domain. Changing it replaces the subscription. */
  resourceGroup: string;
  /** Name of the parent Event Grid domain. Changing it replaces the subscription. */
  domain: string;
}

export interface DomainEventSubscription extends Resource<
  "Azure.EventGrid.DomainEventSubscription",
  DomainEventSubscriptionProps,
  EventSubscriptionAttributes & {
    /** Resource group of the domain. */
    resourceGroup: string;
    /** Name of the parent domain. */
    domain: string;
  },
  never,
  Providers
> {}

/**
 * An event subscription on an Event Grid domain. It receives events
 * published to every topic of the domain (filter on `subject` to narrow
 * it). It is the same ARM object that `Azure.EventGrid.EventSubscription`
 * creates with `scope: domain.domainId`.
 *
 * Event subscriptions have no tags; Alchemy records ownership in a label
 * (`alchemy:{stack}/{stage}/{id}`).
 *
 * @see https://learn.microsoft.com/azure/event-grid/event-domains
 *
 * ### Subscribing to a Domain
 * **Example:** Deliver all domain events to a Storage queue
 * ```typescript
 * const domain = yield* Azure.EventGrid.Domain("tenants", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const audit = yield* Azure.EventGrid.DomainEventSubscription("audit", {
 *   resourceGroup: group.resourceGroupName,
 *   domain: domain.domainName,
 *   destination: {
 *     endpointType: "StorageQueue",
 *     resourceId: account.storageAccountId,
 *     queueName: "audit",
 *   },
 * });
 * ```
 *
 * **Example:** Only events of one domain topic
 * ```typescript
 * const tenantA = yield* Azure.EventGrid.DomainEventSubscription("tenant-a", {
 *   resourceGroup: group.resourceGroupName,
 *   domain: domain.domainName,
 *   destination: {
 *     endpointType: "StorageQueue",
 *     resourceId: account.storageAccountId,
 *     queueName: "tenant-a",
 *   },
 *   filter: { subjectBeginsWith: "/tenants/a/" },
 * });
 * ```
 *
 * @resource
 */
export const DomainEventSubscription = Resource<DomainEventSubscription>(
  "Azure.EventGrid.DomainEventSubscription",
);

const getSubscription = (
  subscriptionId: string,
  resourceGroupName: string,
  domainName: string,
  eventSubscriptionName: string,
) =>
  orUndefinedIfNotFound(
    eventgrid.GetDomainEventSubscription({
      subscriptionId,
      resourceGroupName,
      domainName,
      eventSubscriptionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  domain: string,
  name: string,
  observed: ObservedSubscription,
): DomainEventSubscription["Attributes"] => ({
  ...toSubscriptionAttrs(name, observed),
  resourceGroup,
  domain,
});

export const DomainEventSubscriptionProvider = () =>
  Provider.succeed(DomainEventSubscription, {
    stables: [
      "eventSubscriptionName",
      "eventSubscriptionId",
      "resourceGroup",
      "domain",
    ],

    // Deleted with their domain.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.domain, output.domain) ||
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
      if (resourceGroup === undefined || domain === undefined) {
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
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, domain, name, observed);
      return (yield* isOwnedSubscription(id, observed))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventGrid");
      const { resourceGroup, domain } = news;
      const name =
        news.name ??
        output?.eventSubscriptionName ??
        (yield* createEventGridName(id, 64));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        domainName: domain,
        eventSubscriptionName: name,
      };
      const desired = yield* desiredSubscription(id, news);
      const observed = yield* reconcileSubscription(
        {
          label: `event grid domain event subscription ${name}`,
          get: getSubscription(subscriptionId, resourceGroup, domain, name),
          create: (properties) =>
            eventgrid.DomainEventSubscriptionsCreateOrUpdate({
              ...where,
              properties,
            }),
          update: (patch) =>
            eventgrid.UpdateDomainEventSubscription({
              ...where,
              ...patch,
            }),
          fullUrl: eventgrid
            .GetDomainEventSubscriptionFullUrl(where)
            .pipe(Effect.map((result) => result.endpointUrl)),
        },
        desired,
      );
      return toAttrs(resourceGroup, domain, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventgrid.DeleteDomainEventSubscription({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          domainName: output.domain,
          eventSubscriptionName: output.eventSubscriptionName,
        }),
      );
      yield* waitUntilGone(
        `event grid domain event subscription ${output.eventSubscriptionName}`,
        getSubscription(
          subscriptionId,
          output.resourceGroup,
          output.domain,
          output.eventSubscriptionName,
        ),
        { times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.EventGrid.Domain"] },
  });
