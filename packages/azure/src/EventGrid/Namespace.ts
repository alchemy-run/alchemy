import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  createEventGridName,
  identityDiffers,
  ipRulesDiffer,
  redactKeys,
  sameName,
  setIfChanged,
  toIdentityInfo,
  toIpRules,
  type EventGridIdentity,
  type EventGridInboundIpRule,
} from "./common.ts";

/** MQTT broker settings of a namespace. */
export interface NamespaceTopicSpacesConfiguration {
  /**
   * Whether the MQTT broker is enabled.
   *
   * :::caution
   * Azure does not allow disabling it once enabled, so switching to
   * `Disabled` replaces the namespace.
   * :::
   */
  state: "Enabled" | "Disabled";
  /**
   * ARM ID of a namespace topic that receives routed MQTT messages.
   * @default no routing
   */
  routeTopicResourceId?: string;
  /**
   * Maximum session expiry in hours (1-8).
   * @default Azure's default (`1`)
   */
  maximumSessionExpiryInHours?: number;
  /**
   * Maximum number of sessions per authentication name (1-100).
   * @default Azure's default (`1`)
   */
  maximumClientSessionsPerAuthenticationName?: number;
}

export interface NamespaceProps {
  /**
   * Resource group the namespace is created in.
   *
   * :::caution
   * Changing it replaces the namespace.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Namespace name: 3-50 letters, digits, and hyphens, unique per region.
   * If omitted, a unique name is generated from the app, stage, and logical
   * ID.
   *
   * :::caution
   * Changing it replaces the namespace.
   * :::
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location of the namespace.
   *
   * :::caution
   * Changing it replaces the namespace.
   * :::
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Throughput units of the `Standard` SKU (1-40). Each unit is billed
   * hourly.
   * @default 1
   */
  capacity?: number;
  /**
   * Spread the namespace across availability zones.
   *
   * :::caution
   * Changing it replaces the namespace.
   * :::
   * @default Azure's default for the region
   */
  isZoneRedundant?: boolean;
  /**
   * MQTT broker settings. Omit to leave the broker disabled.
   * @default broker disabled
   */
  topicSpacesConfiguration?: NamespaceTopicSpacesConfiguration;
  /**
   * Whether the public endpoints accept traffic.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * IP ranges allowed to connect while `publicNetworkAccess` is `Enabled`.
   * An empty list (the default) allows every address.
   * @default []
   */
  inboundIpRules?: EventGridInboundIpRule[];
  /**
   * Managed identity of the namespace, used for push delivery
   * (`push.deliveryIdentity` on a namespace topic subscription).
   * @default the observed identity is kept (none on a new namespace)
   */
  identity?: EventGridIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface Namespace extends Resource<
  "Azure.EventGrid.Namespace",
  NamespaceProps,
  {
    /** Name of the namespace. */
    namespaceName: string;
    /** ARM resource ID of the namespace. */
    namespaceId: string;
    /** Resource group that holds the namespace. */
    resourceGroup: string;
    /** Location of the namespace. */
    location: string;
    /** Throughput units. */
    capacity: number;
    /** Whether the namespace is zone redundant. */
    isZoneRedundant: boolean | undefined;
    /** Whether the MQTT broker is enabled. */
    topicSpacesEnabled: boolean;
    /** Hostname for publishing to and receiving from namespace topics. */
    topicsHostname: string | undefined;
    /** MQTT broker hostname (when the broker is enabled). */
    topicSpacesHostname: string | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** Primary SAS key. */
    primaryKey: Redacted.Redacted<string> | undefined;
    /** Secondary SAS key. */
    secondaryKey: Redacted.Redacted<string> | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Event Grid namespace (`Microsoft.EventGrid/namespaces`): hosts
 * namespace topics that take CloudEvents over HTTP, with pull (queue) or
 * push delivery, and optionally an MQTT broker for devices.
 *
 * Alchemy creates a `Standard` namespace with one throughput unit in the
 * stack's resource group. Bind its namespace topics and subscriptions to
 * your runtimes: publish bindings assign **EventGrid Data Sender** on the
 * namespace topic, and receive bindings assign a receive-only custom role
 * on the event subscription, never on the whole namespace.
 *
 * :::caution[Throughput units are billed by the hour]
 * Each unit of `capacity` is billed while the namespace exists, even with
 * no traffic.
 * :::
 *
 * :::caution[Changing `name`, `resourceGroup`, `location`, `isZoneRedundant`, or turning the MQTT broker off replaces the namespace]
 * Alchemy creates a new namespace and deletes the old one with every
 * namespace topic, subscription, retained event, and MQTT client in it.
 * :::
 *
 * @see https://learn.microsoft.com/azure/event-grid/concepts-event-grid-namespaces
 *
 * ### Creating a Namespace
 * **Example:** Namespace with one throughput unit
 * ```typescript
 * const events = yield* Azure.EventGrid.Namespace("events");
 * // events.topicsHostname → "<name>.<region>-1.eventgrid.azure.net"
 * ```
 *
 * **Example:** Two throughput units across zones
 * ```typescript
 * const events = yield* Azure.EventGrid.Namespace("events", {
 *   capacity: 2,
 *   isZoneRedundant: true,
 * });
 * ```
 *
 * ### Topics and Pull Delivery
 * A queue subscription holds events until a receiver takes them, like a
 * message queue. Receivers lock, then acknowledge, release, or reject each
 * event.
 *
 * **Example:** Topic with a queue subscription for workers
 * ```typescript
 * const orders = yield* Azure.EventGrid.NamespaceTopic("orders", {
 *   namespace: events.namespaceName,
 *   eventRetentionInDays: 1,
 * });
 * const workers = yield* Azure.EventGrid.NamespaceTopicEventSubscription("workers", {
 *   namespace: events.namespaceName,
 *   topic: orders.namespaceTopicName,
 *   queue: { receiveLockDurationInSeconds: 120, maxDeliveryCount: 10 },
 *   includedEventTypes: ["Order.Created"],
 * });
 * ```
 *
 * ### Push Delivery
 * **Example:** Push a topic's events to an event hub
 * ```typescript
 * const events = yield* Azure.EventGrid.Namespace("events", {
 *   identity: { type: "SystemAssigned" },
 * });
 * yield* Azure.EventGrid.NamespaceTopicEventSubscription("to-hub", {
 *   namespace: events.namespaceName,
 *   topic: orders.namespaceTopicName,
 *   push: {
 *     destination: { endpointType: "EventHub", resourceId: hub.eventHubId },
 *     deliveryIdentity: { type: "SystemAssigned" },
 *   },
 * });
 * // also grant the namespace identity Azure Event Hubs Data Sender on the hub
 * ```
 *
 * ### MQTT Broker
 * Turn on the broker to connect devices over MQTT. Once on, Azure does not
 * let you turn it off.
 *
 * **Example:** Namespace with the MQTT broker enabled
 * ```typescript
 * const iot = yield* Azure.EventGrid.Namespace("iot", {
 *   capacity: 2,
 *   topicSpacesConfiguration: { state: "Enabled", maximumSessionExpiryInHours: 8 },
 * });
 * // iot.topicSpacesHostname is the MQTT endpoint
 * ```
 *
 * ### Network Access
 * **Example:** Allow one IP range
 * ```typescript
 * const events = yield* Azure.EventGrid.Namespace("events", {
 *   inboundIpRules: [{ ipMask: "203.0.113.0/24" }],
 * });
 * ```
 *
 * ### Binding to a runtime
 * **Example:** Publish and receive CloudEvents in an Azure Function
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const topic = yield* Orders;
 *     const subscription = yield* Workers;
 *     const publish = yield* Azure.EventGrid.PublishCloudEvent(topic);
 *     const receive = yield* Azure.EventGrid.ReceiveCloudEvents(subscription);
 *     const acknowledge = yield* Azure.EventGrid.AcknowledgeCloudEvents(subscription);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* publish({
 *           id: "order-42",
 *           source: "/orders",
 *           type: "Order.Created",
 *           specversion: "1.0",
 *           data: { orderId: "42" },
 *         });
 *         const received = yield* receive({ maxEvents: 10, maxWaitTime: 10 });
 *         const lockTokens = received.value.map((r) => r.brokerProperties.lockToken);
 *         if (lockTokens.length > 0) yield* acknowledge({ lockTokens });
 *         return yield* HttpServerResponse.json({ handled: lockTokens.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(
 *     Effect.provide(
 *       Layer.mergeAll(
 *         Azure.EventGrid.PublishCloudEventHttp,
 *         Azure.EventGrid.ReceiveCloudEventsHttp,
 *         Azure.EventGrid.AcknowledgeCloudEventsHttp,
 *       ),
 *     ),
 *   ),
 * ) {}
 * ```
 *
 * ### Runtime Operations
 * **Example:** Release an event for later or reject it
 * ```typescript
 * // init
 * const release = yield* Azure.EventGrid.ReleaseCloudEvents(subscription);
 * const reject = yield* Azure.EventGrid.RejectCloudEvents(subscription);
 * const renew = yield* Azure.EventGrid.RenewCloudEventLocks(subscription);
 *
 * // runtime
 * yield* renew({ lockTokens: [token] }); // keep the lock during long work
 * yield* release({ lockTokens: [token] }); // deliver it again
 * yield* reject({ lockTokens: [poisonToken] }); // dead-letter it, or drop it
 * ```
 *
 * @resource
 */
export const Namespace = GroupedResource<Namespace>("Azure.EventGrid.Namespace");

type ObservedNamespace = Pick<
  eventgrid.Namespace,
  "id" | "location" | "properties" | "identity" | "tags" | "sku"
>;

const getNamespace = (subscriptionId: string, resourceGroupName: string, namespaceName: string) =>
  orUndefinedIfNotFound(
    eventgrid.GetNamespace({
      subscriptionId,
      resourceGroupName,
      namespaceName,
    }),
  );

const listKeys = (subscriptionId: string, resourceGroupName: string, namespaceName: string) =>
  orUndefinedIfNotFound(
    eventgrid.ListNamespaceSharedAccessKeys({
      subscriptionId,
      resourceGroupName,
      namespaceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  namespace: ObservedNamespace,
  keys: { key1?: string; key2?: string } | undefined,
): Namespace["Attributes"] => ({
  namespaceName: name,
  namespaceId: namespace.id ?? "",
  resourceGroup,
  location: namespace.location,
  capacity: namespace.sku?.capacity ?? 1,
  isZoneRedundant: namespace.properties?.isZoneRedundant,
  topicSpacesEnabled: namespace.properties?.topicSpacesConfiguration?.state === "Enabled",
  topicsHostname: namespace.properties?.topicsConfiguration?.hostname,
  topicSpacesHostname: namespace.properties?.topicSpacesConfiguration?.hostname,
  principalId: namespace.identity?.principalId,
  ...redactKeys(keys),
  tags: userTags(namespace.tags),
});

/** Namespaces report `CreateFailed`/`UpdatedFailed`; treat them as `Failed`. */
const provisioned = (namespace: ObservedNamespace) => {
  const state = namespace.properties?.provisioningState;
  return state?.endsWith("Failed") ? "Failed" : state;
};

export const NamespaceProvider = () =>
  Provider.succeed(Namespace, {
    stables: ["namespaceName", "namespaceId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(eventgrid.ListNamespaceBySubscription, { subscriptionId });
      return (page.value ?? []).flatMap((namespace) => {
        const group = resourceGroupOf(namespace.id);
        return hasAnyAlchemyTag(namespace.tags) &&
          group !== undefined &&
          namespace.name !== undefined
          ? [toAttrs(group, namespace.name, namespace, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.namespaceName) ||
        (news.location !== undefined && !sameName(news.location, output.location)) ||
        (news.isZoneRedundant !== undefined &&
          output.isZoneRedundant !== undefined &&
          news.isZoneRedundant !== output.isZoneRedundant) ||
        (output.topicSpacesEnabled && news.topicSpacesConfiguration?.state !== "Enabled")
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.namespaceName ?? olds?.name ?? (yield* createEventGridName(id, 50));
      const observed = yield* getNamespace(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const keys = yield* listKeys(subscriptionId, resourceGroup, name);
      const attrs = toAttrs(resourceGroup, name, observed, keys);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventGrid");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.namespaceName ?? (yield* createEventGridName(id, 50));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const identity = toIdentityInfo(news.identity);
      const inboundIpRules = toIpRules(news.inboundIpRules);
      const capacity = news.capacity ?? 1;
      const topicSpaces = news.topicSpacesConfiguration;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        namespaceName: name,
      };
      const get = getNamespace(subscriptionId, resourceGroup, name);
      const label = `event grid namespace ${name}`;
      const budget = { interval: "5 seconds", times: 72 } as const;

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation (1-3 minutes).
      if (observed === undefined) {
        yield* eventgrid.NamespacesCreateOrUpdate({
          ...where,
          location,
          tags,
          identity,
          sku: { name: "Standard", capacity },
          properties: {
            isZoneRedundant: news.isZoneRedundant,
            publicNetworkAccess: news.publicNetworkAccess,
            inboundIpRules,
            topicSpacesConfiguration: topicSpaces,
          },
        });
      }
      observed = yield* waitForProvisioned(label, get, provisioned, budget);

      // Sync mutable aspects against observed state; PATCH only the delta.
      const props = observed.properties ?? {};
      const changed: eventgrid.NamespaceUpdateParameterProperties = {};
      setIfChanged(
        changed,
        "publicNetworkAccess",
        news.publicNetworkAccess,
        props.publicNetworkAccess,
      );
      if (ipRulesDiffer(props.inboundIpRules, inboundIpRules)) {
        changed.inboundIpRules = inboundIpRules;
      }
      if (topicSpaces !== undefined) {
        const have = props.topicSpacesConfiguration ?? {};
        const delta: eventgrid.UpdateTopicSpacesConfigurationInfo = {};
        setIfChanged(delta, "state", topicSpaces.state, have.state ?? "Disabled");
        setIfChanged(
          delta,
          "routeTopicResourceId",
          topicSpaces.routeTopicResourceId,
          have.routeTopicResourceId,
        );
        setIfChanged(
          delta,
          "maximumSessionExpiryInHours",
          topicSpaces.maximumSessionExpiryInHours,
          have.maximumSessionExpiryInHours,
        );
        setIfChanged(
          delta,
          "maximumClientSessionsPerAuthenticationName",
          topicSpaces.maximumClientSessionsPerAuthenticationName,
          have.maximumClientSessionsPerAuthenticationName,
        );
        if (Object.keys(delta).length > 0) {
          changed.topicSpacesConfiguration = {
            ...delta,
            state: topicSpaces.state,
          };
        }
      }
      const skuChanged = (observed.sku?.capacity ?? 1) !== capacity;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      const identityChanged = identityDiffers(observed.identity, news.identity);
      if (Object.keys(changed).length > 0 || skuChanged || tagsChanged || identityChanged) {
        yield* eventgrid.UpdateNamespace({
          ...where,
          sku: skuChanged ? { name: "Standard", capacity } : undefined,
          tags: tagsChanged ? tags : undefined,
          identity: identityChanged ? identity : undefined,
          properties: Object.keys(changed).length > 0 ? changed : undefined,
        });
        observed = yield* waitForProvisioned(label, get, provisioned, budget);
      }

      const keys = yield* listKeys(subscriptionId, resourceGroup, name);
      return toAttrs(resourceGroup, name, observed, keys);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventgrid.DeleteNamespace({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          namespaceName: output.namespaceName,
        }),
      );
      yield* waitUntilGone(
        `event grid namespace ${output.namespaceName}`,
        getNamespace(subscriptionId, output.resourceGroup, output.namespaceName).pipe(
          Effect.map((namespace) =>
            namespace?.properties?.provisioningState === "Deleted" ? undefined : namespace,
          ),
        ),
        { interval: "5 seconds", times: 72 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
