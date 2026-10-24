import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, waitUntilGone } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
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

export interface PartnerTopicEventSubscriptionProps extends EventSubscriptionSettings {
  /** Resource group of the partner topic. Changing it replaces the subscription. */
  resourceGroup: string;
  /** Name of the parent partner topic. Changing it replaces the subscription. */
  partnerTopic: string;
  /**
   * Schema of delivered events. Partner topics take CloudEvents v1.0 input,
   * so Event Grid accepts only `CloudEventSchemaV1_0`.
   * @default "CloudEventSchemaV1_0"
   */
  eventDeliverySchema?: "CloudEventSchemaV1_0";
}

/** The only delivery schema a partner topic's CloudEvents input allows. */
const deliverySchema = "CloudEventSchemaV1_0" as const;

export interface PartnerTopicEventSubscription extends Resource<
  "Azure.EventGrid.PartnerTopicEventSubscription",
  PartnerTopicEventSubscriptionProps,
  EventSubscriptionAttributes & {
    /** Resource group of the partner topic. */
    resourceGroup: string;
    /** Name of the parent partner topic. */
    partnerTopic: string;
  },
  never,
  Providers
> {}

/**
 * An event subscription on an Event Grid partner topic
 * (`Microsoft.EventGrid/partnerTopics/eventSubscriptions`) — routes events a
 * SaaS partner publishes (Auth0 logins, Graph API changes, your own partner
 * namespace, …) to a destination. The partner topic must be activated
 * first, e.g. by an `Azure.EventGrid.PartnerTopic`.
 *
 * Event subscriptions have no tags; Alchemy records ownership in a label
 * (`alchemy:{stack}/{stage}/{id}`).
 *
 * @see https://learn.microsoft.com/azure/event-grid/subscribe-to-partner-events
 *
 * ### Subscribing to Partner Events
 * **Example:** Partner events to a Storage queue
 * ```typescript
 * const orders = yield* Azure.EventGrid.PartnerTopic("orders", {
 *   name: "contoso-orders",
 * });
 * const created = yield* Azure.EventGrid.PartnerTopicEventSubscription(
 *   "orders-created",
 *   {
 *     partnerTopic: orders.partnerTopicName,
 *     destination: {
 *       endpointType: "StorageQueue",
 *       resourceId: account.storageAccountId,
 *       queueName: "orders",
 *     },
 *     filter: {
 *       includedEventTypes: ["Contoso.OrderCreated"],
 *     },
 *   },
 * );
 * ```
 *
 * @resource
 */
export const PartnerTopicEventSubscription = GroupedResource<PartnerTopicEventSubscription>(
  "Azure.EventGrid.PartnerTopicEventSubscription",
);

const getSubscription = (
  subscriptionId: string,
  resourceGroupName: string,
  partnerTopicName: string,
  eventSubscriptionName: string,
) =>
  orUndefinedIfNotFound(
    eventgrid.GetPartnerTopicEventSubscription({
      subscriptionId,
      resourceGroupName,
      partnerTopicName,
      eventSubscriptionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  partnerTopic: string,
  name: string,
  observed: ObservedSubscription,
): PartnerTopicEventSubscription["Attributes"] => ({
  ...toSubscriptionAttrs(name, observed),
  resourceGroup,
  partnerTopic,
});

export const PartnerTopicEventSubscriptionProvider = () =>
  Provider.succeed(PartnerTopicEventSubscription, {
    stables: ["eventSubscriptionName", "eventSubscriptionId", "resourceGroup", "partnerTopic"],

    // Deleted with their partner topic.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.partnerTopic, output.partnerTopic) ||
        (news.name !== undefined && news.name !== output.eventSubscriptionName) ||
        (news.eventDeliverySchema ?? deliverySchema) !== output.eventDeliverySchema
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const partnerTopic = output?.partnerTopic ?? olds?.partnerTopic;
      if (resourceGroup === undefined || partnerTopic === undefined) {
        return undefined;
      }
      const name =
        output?.eventSubscriptionName ?? olds?.name ?? (yield* createEventGridName(id, 64));
      const observed = yield* getSubscription(subscriptionId, resourceGroup, partnerTopic, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, partnerTopic, name, observed);
      return (yield* isOwnedSubscription(id, observed)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventGrid");
      const { resourceGroup, partnerTopic } = news;
      const name =
        news.name ?? output?.eventSubscriptionName ?? (yield* createEventGridName(id, 64));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        partnerTopicName: partnerTopic,
        eventSubscriptionName: name,
      };
      const desired = yield* desiredSubscription(id, {
        ...news,
        eventDeliverySchema: news.eventDeliverySchema ?? deliverySchema,
      });
      const observed = yield* reconcileSubscription(
        {
          label: `partner topic event subscription ${name}`,
          get: getSubscription(subscriptionId, resourceGroup, partnerTopic, name),
          create: (properties) =>
            eventgrid.PartnerTopicEventSubscriptionsCreateOrUpdate({
              ...where,
              properties,
            }),
          update: (patch) =>
            eventgrid.UpdatePartnerTopicEventSubscription({
              ...where,
              ...patch,
            }),
          fullUrl: eventgrid
            .GetPartnerTopicEventSubscriptionFullUrl(where)
            .pipe(Effect.map((result) => result.endpointUrl)),
        },
        desired,
      );
      return toAttrs(resourceGroup, partnerTopic, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventgrid.DeletePartnerTopicEventSubscription({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          partnerTopicName: output.partnerTopic,
          eventSubscriptionName: output.eventSubscriptionName,
        }),
      );
      yield* waitUntilGone(
        `partner topic event subscription ${output.eventSubscriptionName}`,
        getSubscription(
          subscriptionId,
          output.resourceGroup,
          output.partnerTopic,
          output.eventSubscriptionName,
        ),
        { times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.EventGrid.PartnerTopic"] },
  });
