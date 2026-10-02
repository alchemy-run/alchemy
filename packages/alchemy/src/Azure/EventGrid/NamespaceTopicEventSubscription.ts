import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import * as Effect from "effect/Effect";
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
import { createEventGridName, sameName } from "./common.ts";
import {
  destinationDiffers,
  toWireDestination,
  type EventSubscriptionDeliveryIdentity,
  type EventSubscriptionDestination,
} from "./EventSubscriptionShared.ts";

/** A filter on a CloudEvent attribute of a namespace subscription. */
export interface NamespaceSubscriptionFilter {
  /** Operator, e.g. `StringIn`, `StringBeginsWith`, `NumberGreaterThan`, `BoolEquals`. */
  operatorType: eventgrid.FilterOperatorType;
  /** CloudEvent attribute to filter on, e.g. `source`, `subject`, `data.region`. */
  key: string;
  /** Single comparison value (`NumberGreaterThan`, `BoolEquals`, …). */
  value?: number | boolean;
  /** Comparison values (`StringIn`, `NumberIn`, `NumberInRange`, …). */
  values?: (string | number | number[])[];
}

/** Pull (queue) delivery settings. */
export interface NamespaceSubscriptionQueue {
  /**
   * Seconds a received event stays locked before it is redelivered (60-300).
   * @default Azure's default (`60`)
   */
  receiveLockDurationInSeconds?: number;
  /** Maximum delivery attempts (1-10). @default Azure's default (`10`) */
  maxDeliveryCount?: number;
  /**
   * How long events stay available, as an ISO 8601 duration (e.g. `P1D`,
   * `PT12H`). Cannot exceed the topic's retention.
   * @default the topic's `eventRetentionInDays`
   */
  eventTimeToLive?: string;
}

/** Push delivery settings. */
export interface NamespaceSubscriptionPush {
  /** Where events are pushed (Event Hub, webhook, or namespace topic). */
  destination: EventSubscriptionDestination;
  /**
   * Deliver with the namespace's managed identity instead of keys. The
   * namespace must have that identity and it needs a role on the destination.
   */
  deliveryIdentity?: EventSubscriptionDeliveryIdentity;
  /** Maximum delivery attempts (1-10). @default Azure's default (`10`) */
  maxDeliveryCount?: number;
  /** How long events stay deliverable, as an ISO 8601 duration. */
  eventTimeToLive?: string;
}

export interface NamespaceTopicEventSubscriptionProps {
  /** Resource group of the namespace. Changing it replaces the subscription. */
  resourceGroup: string;
  /** Name of the Event Grid namespace. Changing it replaces the subscription. */
  namespace: string;
  /** Name of the namespace topic. Changing it replaces the subscription. */
  topic: string;
  /**
   * Subscription name: 3-50 letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the subscription.
   */
  name?: string;
  /**
   * Pull delivery: consumers receive, acknowledge, release, or reject events
   * through the namespace data plane. Set exactly one of `queue` or `push`;
   * switching between them replaces the subscription.
   */
  queue?: NamespaceSubscriptionQueue;
  /** Push delivery to a destination. Mutually exclusive with `queue`. */
  push?: NamespaceSubscriptionPush;
  /** Event types to deliver. Omit for all event types. */
  includedEventTypes?: string[];
  /** Filters on CloudEvent attributes (all must match). */
  filters?: NamespaceSubscriptionFilter[];
  /** Expiration time (ISO 8601). Azure deletes the subscription after it. */
  expirationTimeUtc?: string;
}

export interface NamespaceTopicEventSubscription extends Resource<
  "Azure.EventGrid.NamespaceTopicEventSubscription",
  NamespaceTopicEventSubscriptionProps,
  {
    /** Name of the event subscription. */
    eventSubscriptionName: string;
    /** ARM resource ID of the event subscription. */
    eventSubscriptionId: string;
    /** Resource group of the namespace. */
    resourceGroup: string;
    /** Name of the namespace. */
    namespace: string;
    /** Name of the namespace topic. */
    topic: string;
    /** Delivery mode: `Queue` (pull) or `Push`. */
    deliveryMode: "Queue" | "Push";
  },
  never,
  Providers
> {}

/**
 * An event subscription on an Event Grid namespace topic. In `Queue` mode
 * consumers pull CloudEvents through the namespace data plane; in `Push`
 * mode Event Grid delivers them to an Event Hub or webhook.
 *
 * Namespace subscriptions have no tags or labels; ownership follows the
 * parent namespace.
 *
 * @see https://learn.microsoft.com/azure/event-grid/pull-delivery-overview
 *
 * ### Pull Delivery
 * **Example:** Queue subscription for order events
 * ```typescript
 * const namespace = yield* Azure.EventGrid.Namespace("events", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const orders = yield* Azure.EventGrid.NamespaceTopic("orders", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: namespace.namespaceName,
 * });
 * const workers = yield* Azure.EventGrid.NamespaceTopicEventSubscription(
 *   "workers",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     namespace: namespace.namespaceName,
 *     topic: orders.namespaceTopicName,
 *     queue: { maxDeliveryCount: 5, receiveLockDurationInSeconds: 120 },
 *     includedEventTypes: ["Order.Created"],
 *   },
 * );
 * ```
 *
 * ### Push Delivery
 * **Example:** Push to an Event Hub with the namespace identity
 * ```typescript
 * const toHub = yield* Azure.EventGrid.NamespaceTopicEventSubscription(
 *   "to-hub",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     namespace: namespace.namespaceName,
 *     topic: orders.namespaceTopicName,
 *     push: {
 *       destination: { endpointType: "EventHub", resourceId: hubId },
 *       deliveryIdentity: { type: "SystemAssigned" },
 *     },
 *   },
 * );
 * ```
 *
 * @resource
 */
export const NamespaceTopicEventSubscription =
  Resource<NamespaceTopicEventSubscription>(
    "Azure.EventGrid.NamespaceTopicEventSubscription",
  );

type ObservedSubscription = Pick<eventgrid.Subscription, "id" | "properties">;

const getSubscription = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
  topicName: string,
  eventSubscriptionName: string,
) =>
  orUndefinedIfNotFound(
    eventgrid.GetNamespaceTopicEventSubscription({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      topicName,
      eventSubscriptionName,
    }),
  );

const modeOf = (props: { push?: unknown }) =>
  props.push !== undefined ? ("Push" as const) : ("Queue" as const);

const toAttrs = (
  resourceGroup: string,
  namespace: string,
  topic: string,
  name: string,
  observed: ObservedSubscription,
): NamespaceTopicEventSubscription["Attributes"] => ({
  eventSubscriptionName: name,
  eventSubscriptionId: observed.id ?? "",
  resourceGroup,
  namespace,
  topic,
  deliveryMode:
    observed.properties?.deliveryConfiguration?.deliveryMode === "Push"
      ? "Push"
      : "Queue",
});

/** Desired delivery configuration in wire form. */
const desiredDelivery = (
  props: NamespaceTopicEventSubscriptionProps,
): eventgrid.DeliveryConfiguration => {
  if (props.push !== undefined) {
    const { destination, deliveryIdentity, ...rest } = props.push;
    const wire = toWireDestination(destination);
    return {
      deliveryMode: "Push",
      push: {
        ...rest,
        destination: deliveryIdentity ? undefined : wire,
        deliveryWithResourceIdentity: deliveryIdentity
          ? { identity: deliveryIdentity, destination: wire }
          : undefined,
      },
    };
  }
  return { deliveryMode: "Queue", queue: { ...props.queue } };
};

const desiredFilters = (
  props: NamespaceTopicEventSubscriptionProps,
): eventgrid.FiltersConfiguration => ({
  includedEventTypes: props.includedEventTypes,
  filters: props.filters,
});

const normalizeFilters = (filters: eventgrid.FiltersConfiguration | undefined) =>
  JSON.stringify({
    includedEventTypes: [...(filters?.includedEventTypes ?? [])].sort(),
    filters: (filters?.filters ?? []).map((f) => ({
      operatorType: f.operatorType,
      key: f.key,
      value: f.value,
      values: f.values,
    })),
  });

/** Whether any desired scalar of `want` differs from `have`. */
const scalarsDiffer = (
  have: Record<string, unknown> | undefined,
  want: Record<string, unknown>,
) =>
  Object.entries(want).some(
    ([key, value]) =>
      value !== undefined &&
      typeof value !== "object" &&
      value !== (have ?? {})[key],
  );

const deliveryDiffers = (
  observed: eventgrid.DeliveryConfiguration | undefined,
  desired: eventgrid.DeliveryConfiguration,
) => {
  if (desired.deliveryMode === "Queue") {
    return scalarsDiffer(
      observed?.queue as Record<string, unknown> | undefined,
      (desired.queue ?? {}) as Record<string, unknown>,
    );
  }
  const have = observed?.push;
  const want = desired.push ?? {};
  if (
    scalarsDiffer(
      have as Record<string, unknown> | undefined,
      want as Record<string, unknown>,
    )
  ) {
    return true;
  }
  if (want.destination !== undefined) {
    return (
      have?.deliveryWithResourceIdentity !== undefined ||
      destinationDiffers(have?.destination, want.destination, undefined)
    );
  }
  const withIdentity = want.deliveryWithResourceIdentity;
  return (
    withIdentity !== undefined &&
    (have?.deliveryWithResourceIdentity?.identity?.type !==
      withIdentity.identity?.type ||
      (have?.deliveryWithResourceIdentity?.identity?.userAssignedIdentity ?? "")
        .toLowerCase() !==
        (withIdentity.identity?.userAssignedIdentity ?? "").toLowerCase() ||
      destinationDiffers(
        have?.deliveryWithResourceIdentity?.destination,
        withIdentity.destination,
        undefined,
      ))
  );
};

export const NamespaceTopicEventSubscriptionProvider = () =>
  Provider.succeed(NamespaceTopicEventSubscription, {
    stables: [
      "eventSubscriptionName",
      "eventSubscriptionId",
      "resourceGroup",
      "namespace",
      "topic",
      "deliveryMode",
    ],

    // Deleted with their namespace topic.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespace) ||
        !sameName(news.topic, output.topic) ||
        (news.name !== undefined &&
          news.name !== output.eventSubscriptionName) ||
        modeOf(news) !== output.deliveryMode
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    // No tags or labels; ownership follows the parent namespace.
    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const namespace = output?.namespace ?? olds?.namespace;
      const topic = output?.topic ?? olds?.topic;
      if (
        resourceGroup === undefined ||
        namespace === undefined ||
        topic === undefined
      ) {
        return undefined;
      }
      const name =
        output?.eventSubscriptionName ??
        olds?.name ??
        (yield* createEventGridName(id, 50));
      const observed = yield* getSubscription(
        subscriptionId,
        resourceGroup,
        namespace,
        topic,
        name,
      );
      if (observed === undefined) return undefined;
      return toAttrs(resourceGroup, namespace, topic, name, observed);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventGrid");
      const { resourceGroup, namespace, topic } = news;
      const name =
        news.name ??
        output?.eventSubscriptionName ??
        (yield* createEventGridName(id, 50));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        namespaceName: namespace,
        topicName: topic,
        eventSubscriptionName: name,
      };
      const get = getSubscription(
        subscriptionId,
        resourceGroup,
        namespace,
        topic,
        name,
      );
      const label = `event grid namespace topic event subscription ${name}`;
      const stateOf = (sub: ObservedSubscription) =>
        sub.properties?.provisioningState;
      const budget = { times: 60 } as const;
      const delivery = desiredDelivery(news);
      const filters = desiredFilters(news);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* eventgrid.NamespaceTopicEventSubscriptionsCreateOrUpdate({
          ...where,
          properties: {
            deliveryConfiguration: delivery,
            eventDeliverySchema: "CloudEventSchemaV1_0",
            filtersConfiguration: filters,
            expirationTimeUtc: news.expirationTimeUtc,
          },
        });
      }
      observed = yield* waitForProvisioned(label, get, stateOf, budget);

      // Sync against observed state; PATCH only the delta.
      const props = observed.properties ?? {};
      const patch: eventgrid.SubscriptionUpdateParametersProperties = {};
      if (deliveryDiffers(props.deliveryConfiguration, delivery)) {
        const have = props.deliveryConfiguration;
        patch.deliveryConfiguration =
          delivery.deliveryMode === "Queue"
            ? {
                deliveryMode: "Queue",
                queue: { ...have?.queue, ...stripUndefined(delivery.queue) },
              }
            : {
                deliveryMode: "Push",
                push: { ...have?.push, ...stripUndefined(delivery.push) },
              };
      }
      if (normalizeFilters(props.filtersConfiguration) !== normalizeFilters(filters)) {
        patch.filtersConfiguration = filters;
      }
      if (
        news.expirationTimeUtc !== undefined &&
        Date.parse(news.expirationTimeUtc) !==
          Date.parse(props.expirationTimeUtc ?? "")
      ) {
        patch.expirationTimeUtc = news.expirationTimeUtc;
      }
      if (Object.keys(patch).length > 0) {
        yield* eventgrid.UpdateNamespaceTopicEventSubscription({
          ...where,
          properties: patch,
        });
        observed = yield* waitForProvisioned(label, get, stateOf, budget);
      }

      return toAttrs(resourceGroup, namespace, topic, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventgrid.DeleteNamespaceTopicEventSubscription({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          namespaceName: output.namespace,
          topicName: output.topic,
          eventSubscriptionName: output.eventSubscriptionName,
        }),
      );
      yield* waitUntilGone(
        `event grid namespace topic event subscription ${output.eventSubscriptionName}`,
        getSubscription(
          subscriptionId,
          output.resourceGroup,
          output.namespace,
          output.topic,
          output.eventSubscriptionName,
        ),
        { times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.EventGrid.NamespaceTopic"] },
  });

const stripUndefined = <T extends object>(value: T | undefined): Partial<T> =>
  Object.fromEntries(
    Object.entries(value ?? {}).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
