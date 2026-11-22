import * as eventhub from "@distilled.cloud/azure/eventhub";
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
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createNamespaceName, getNamespace, toKeys } from "./Common.ts";

export type NamespaceSkuName = "Basic" | "Standard" | "Premium";
export type NamespaceTlsVersion = "1.0" | "1.1" | "1.2" | "1.3";

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
   * Globally unique namespace name (`{name}.servicebus.windows.net`): 6-50
   * letters, digits, and hyphens, starting with a letter and ending with a
   * letter or digit. If omitted, a unique name is generated from the app,
   * stage, and logical ID.
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
   * Pricing tier. `Basic` allows only the `$Default` consumer group and
   * 1-day retention; `Standard` adds consumer groups, Kafka, Capture,
   * schema registry, and IP firewall rules. Moving between `Basic` and
   * `Standard` happens in place.
   *
   * :::caution
   * Moving to or from `Premium` replaces the namespace.
   * :::
   * @default "Standard"
   */
  sku?: NamespaceSkuName;
  /**
   * Throughput units (`Basic`/`Standard`, 1-40) or processing units
   * (`Premium`, 1-16).
   * @default 1
   */
  capacity?: number;
  /**
   * Automatically scale up throughput units (`Standard` only).
   * @default false
   */
  isAutoInflateEnabled?: boolean;
  /**
   * Upper limit for auto-inflate (`Standard` only, 0-40). Required when
   * `isAutoInflateEnabled` is `true`.
   * @default not set (auto-inflate off)
   */
  maximumThroughputUnits?: number;
  /**
   * Minimum TLS version clients must use. Azure retired TLS 1.0 and 1.1
   * for Event Hubs and keeps `1.2` when a lower version is requested.
   * @default "1.2"
   */
  minimumTlsVersion?: NamespaceTlsVersion;
  /**
   * Whether the public endpoint accepts traffic.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled" | "SecuredByPerimeter";
  /**
   * Disable SAS (shared access key) authentication and require Microsoft
   * Entra ID.
   * @default Azure's default (`false`)
   */
  disableLocalAuth?: boolean;
  /**
   * Spread the namespace across availability zones. Azure sets it only at
   * creation.
   *
   * :::caution
   * Changing it replaces the namespace.
   * :::
   * @default Azure's default for the region
   */
  zoneRedundant?: boolean;
  /**
   * ARM ID of a dedicated Event Hubs cluster (`Azure.EventHub.Cluster`) to
   * place the namespace in.
   *
   * :::caution
   * Changing it replaces the namespace.
   * :::
   * @default no cluster (shared capacity)
   */
  clusterArmId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface Namespace extends Resource<
  "Azure.EventHub.Namespace",
  NamespaceProps,
  {
    /** Name of the namespace. */
    namespaceName: string;
    /** ARM resource ID of the namespace; use it as a role-assignment scope. */
    namespaceId: string;
    /** Resource group that holds the namespace. */
    resourceGroup: string;
    /** Location of the namespace. */
    location: string;
    /** Pricing tier. */
    sku: string;
    /** Throughput or processing units. */
    capacity: number | undefined;
    /** Service Bus endpoint, e.g. `https://{name}.servicebus.windows.net:443/`. */
    serviceBusEndpoint: string | undefined;
    /** Identifier for Azure Monitor metrics. */
    metricId: string | undefined;
    /** Namespace status, e.g. `Active`. */
    status: string | undefined;
    /** Whether the namespace is zone redundant. */
    zoneRedundant: boolean | undefined;
    /** Dedicated cluster hosting the namespace, if any. */
    clusterArmId: string | undefined;
    /**
     * Primary connection string of the built-in `RootManageSharedAccessKey`
     * rule (full Manage/Send/Listen rights).
     */
    primaryConnectionString: Redacted.Redacted<string> | undefined;
    /** Primary key of the built-in `RootManageSharedAccessKey` rule. */
    primaryKey: Redacted.Redacted<string> | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Event Hubs namespace (`Microsoft.EventHub/namespaces`): the
 * container and endpoint (`<name>.servicebus.windows.net`) for your event
 * hubs, consumer groups, schema groups, and access policies.
 *
 * Alchemy creates a `Standard` namespace with one throughput unit in the
 * stack's resource group, with TLS 1.2 as the minimum. Bind the event hubs
 * in it to your runtimes: each binding assigns an Event Hubs data role on
 * that one event hub, so your code never handles a connection string. The
 * built-in `RootManageSharedAccessKey` connection string is still an
 * attribute (a `Redacted` secret) for Kafka clients and tools that need one.
 *
 * :::caution[Changing `name`, `resourceGroup`, `location`, `zoneRedundant`, `clusterArmId`, or moving to or from `Premium` replaces the namespace]
 * Alchemy creates a new namespace and deletes the old one with every event
 * hub and every retained event in it.
 * :::
 *
 * @see https://learn.microsoft.com/azure/event-hubs/event-hubs-features
 *
 * ### Creating a Namespace
 * **Example:** Standard namespace
 * ```typescript
 * const hubs = yield* Azure.EventHub.Namespace("hubs");
 * ```
 *
 * **Example:** Namespace with a fixed name and region
 * ```typescript
 * const hubs = yield* Azure.EventHub.Namespace("hubs", {
 *   name: "contoso-telemetry",
 *   location: "westeurope",
 * });
 * ```
 *
 * ### Choosing a Tier
 * `Basic` has only the `$Default` consumer group and one day of retention.
 * `Standard` adds consumer groups, seven days of retention, the Kafka
 * endpoint, Capture, the schema registry, and IP firewall rules. `Premium`
 * runs on dedicated processing units with up to 90 days of retention. You
 * can switch between `Basic` and `Standard` in place.
 *
 * **Example:** Basic namespace
 * ```typescript
 * const hubs = yield* Azure.EventHub.Namespace("hubs", {
 *   sku: "Basic",
 * });
 * ```
 *
 * **Example:** Zone-redundant Premium namespace with two processing units
 * ```typescript
 * const hubs = yield* Azure.EventHub.Namespace("hubs", {
 *   sku: "Premium",
 *   capacity: 2,
 *   zoneRedundant: true,
 * });
 * ```
 *
 * ### Scaling
 * One throughput unit takes 1 MB/s or 1,000 events/s in, and sends 2 MB/s
 * out. Auto-inflate raises the count under load, up to
 * `maximumThroughputUnits` (`Standard` only).
 *
 * **Example:** Start at two throughput units, grow to ten
 * ```typescript
 * const hubs = yield* Azure.EventHub.Namespace("hubs", {
 *   sku: "Standard",
 *   capacity: 2,
 *   isAutoInflateEnabled: true,
 *   maximumThroughputUnits: 10,
 * });
 * ```
 *
 * ### Authentication
 * **Example:** Accept Microsoft Entra ID only
 * ```typescript
 * const hubs = yield* Azure.EventHub.Namespace("hubs", {
 *   disableLocalAuth: true,
 * });
 * ```
 *
 * **Example:** Listen-only SAS policy for a Kafka consumer
 * ```typescript
 * const reader = yield* Azure.EventHub.NamespaceAuthorizationRule("reader", {
 *   namespace: hubs.namespaceName,
 *   rights: ["Listen"],
 * });
 * // reader.primaryConnectionString is a Redacted secret
 * ```
 *
 * ### Network Access
 * **Example:** Allow one IP range and trusted Azure services
 * ```typescript
 * yield* Azure.EventHub.NetworkRuleSet("hubs-firewall", {
 *   namespace: hubs.namespaceName,
 *   defaultAction: "Deny",
 *   ipRules: [{ ipMask: "203.0.113.0/24" }],
 *   trustedServiceAccessEnabled: true,
 * });
 * ```
 *
 * **Example:** Private endpoint in your virtual network
 * ```typescript
 * const hubs = yield* Azure.EventHub.Namespace("hubs", {
 *   publicNetworkAccess: "Disabled",
 * });
 * yield* Azure.Network.PrivateEndpoint("hubs-endpoint", {
 *   subnetId: subnet.subnetId,
 *   privateLinkServiceConnections: [
 *     { privateLinkServiceId: hubs.namespaceId, groupIds: ["namespace"] },
 *   ],
 * });
 * ```
 *
 * ### Dedicated Clusters
 * **Example:** Place a namespace in an Event Hubs cluster
 * ```typescript
 * // A dedicated cluster bills by the hour, whether you use it or not.
 * const cluster = yield* Azure.EventHub.Cluster("cluster");
 * const hubs = yield* Azure.EventHub.Namespace("hubs", {
 *   clusterArmId: cluster.clusterId,
 * });
 * ```
 *
 * ### Binding to a runtime
 * Bind the event hubs in the namespace, not the namespace itself. `Send`
 * assigns **Azure Event Hubs Data Sender** on that event hub only.
 *
 * **Example:** Send events from an Azure Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const hub = yield* Readings;
 *     const readings = yield* Azure.EventHub.Send(hub);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* readings.send({ deviceId: "d1", temperature: 21 }, { partitionKey: "d1" });
 *         return HttpServerResponse.text("sent", { status: 202 });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.EventHub.SendHttp)),
 * ) {}
 * ```
 *
 * ### Deleting a Namespace
 * Destroying the namespace deletes every event hub and retained event in
 * it.
 *
 * **Example:** Keep the namespace when the stack is destroyed
 * ```typescript
 * import * as RemovalPolicy from "alchemy/RemovalPolicy";
 *
 * const hubs = yield* Azure.EventHub.Namespace("hubs").pipe(RemovalPolicy.retain());
 * ```
 *
 * @resource
 */
export const Namespace = GroupedResource<Namespace>("Azure.EventHub.Namespace");

type ObservedNamespace = eventhub.GetNamespaceResponse;

const lower = (value: string | undefined) => value?.toLowerCase();

/**
 * Ready once ARM reports `Succeeded` and the namespace itself is `Active`;
 * children cannot be created while it is still activating.
 */
const readiness = (namespace: ObservedNamespace) => {
  const state = namespace.properties?.provisioningState;
  const status = namespace.properties?.status;
  if (state === "Succeeded" && status !== undefined && status !== "Active") {
    return status;
  }
  return state;
};

const toAttrs = (
  resourceGroup: string,
  name: string,
  namespace: ObservedNamespace | eventhub.EHNamespace,
  keys?: eventhub.AccessKeys,
): Namespace["Attributes"] => {
  const redacted = keys ? toKeys(keys) : undefined;
  return {
    namespaceName: name,
    namespaceId: namespace.id ?? "",
    resourceGroup,
    location: namespace.location ?? "",
    sku: namespace.sku?.name ?? "",
    capacity: namespace.sku?.capacity,
    serviceBusEndpoint: namespace.properties?.serviceBusEndpoint,
    metricId: namespace.properties?.metricId,
    status: namespace.properties?.status,
    zoneRedundant: namespace.properties?.zoneRedundant,
    clusterArmId: namespace.properties?.clusterArmId,
    primaryConnectionString: redacted?.primaryConnectionString,
    primaryKey: redacted?.primaryKey,
    tags: userTags(namespace.tags),
  };
};

const rootKeys = (subscriptionId: string, resourceGroupName: string, namespaceName: string) =>
  eventhub.ListNamespaceKeys({
    subscriptionId,
    resourceGroupName,
    namespaceName,
    authorizationRuleName: "RootManageSharedAccessKey",
  });

export const NamespaceProvider = () =>
  Provider.succeed(Namespace, {
    stables: [
      "namespaceName",
      "namespaceId",
      "resourceGroup",
      "location",
      "serviceBusEndpoint",
      "metricId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(eventhub.ListNamespaces, { subscriptionId });
      return (page.value ?? []).flatMap((namespace) => {
        const group = resourceGroupOf(namespace.id);
        return hasAnyAlchemyTag(namespace.tags) &&
          group !== undefined &&
          namespace.name !== undefined
          ? [toAttrs(group, namespace.name, namespace)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const sku = news.sku ?? "Standard";
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && lower(news.name) !== lower(output.namespaceName)) ||
        (news.location !== undefined &&
          lower(news.location)?.replace(/\s/g, "") !==
            lower(output.location)?.replace(/\s/g, "")) ||
        (sku === "Premium") !== (output.sku === "Premium") ||
        (news.zoneRedundant !== undefined &&
          news.zoneRedundant !== (output.zoneRedundant ?? false)) ||
        lower(news.clusterArmId) !== lower(output.clusterArmId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      // An interrupted create can persist props with unresolved holes;
      // nothing can exist without its resource group.
      if (resourceGroup === undefined) return undefined;
      const name = output?.namespaceName ?? olds?.name ?? (yield* createNamespaceName(id));
      const observed = yield* getNamespace(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventHub");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.namespaceName ?? (yield* createNamespaceName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const sku = { name: news.sku ?? "Standard", capacity: news.capacity ?? 1 };
      const desired = {
        minimumTlsVersion: news.minimumTlsVersion ?? "1.2",
        publicNetworkAccess: news.publicNetworkAccess,
        disableLocalAuth: news.disableLocalAuth,
        isAutoInflateEnabled:
          sku.name === "Standard" ? (news.isAutoInflateEnabled ?? false) : undefined,
        maximumThroughputUnits: news.isAutoInflateEnabled ? news.maximumThroughputUnits : undefined,
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        namespaceName: name,
      };
      const label = `event hubs namespace ${name}`;
      const get = getNamespace(subscriptionId, resourceGroup, name);
      const waitReady = waitForProvisioned(label, get, readiness, {
        interval: "5 seconds",
        times: 72,
      });

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation; the namespace is
      // usable once it is Succeeded and Active.
      if (observed === undefined) {
        yield* eventhub.NamespacesCreateOrUpdate({
          ...where,
          location,
          sku,
          tags,
          properties: {
            ...desired,
            zoneRedundant: news.zoneRedundant,
            clusterArmId: news.clusterArmId,
          },
        });
      }
      observed = yield* waitReady;

      // Sync SKU, properties, and tags against observed state; PATCH deltas.
      const props = observed.properties ?? {};
      const changed: eventhub.EHNamespacePropertiesInput = {};
      for (const key of Object.keys(desired) as (keyof typeof desired)[]) {
        const value = desired[key];
        if (value !== undefined && props[key] !== value) {
          Object.assign(changed, { [key]: value });
        }
      }
      const observedCapacity = observed.sku?.capacity ?? 1;
      const skuChanged =
        observed.sku?.name !== sku.name ||
        // Auto-inflate raises capacity on its own; only enforce the floor.
        (props.isAutoInflateEnabled
          ? observedCapacity < sku.capacity
          : observedCapacity !== sku.capacity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(changed).length > 0 || skuChanged || tagsChanged) {
        yield* eventhub.UpdateNamespace({
          ...where,
          sku: skuChanged ? sku : undefined,
          tags: tagsChanged ? tags : undefined,
          properties: Object.keys(changed).length > 0 ? changed : undefined,
        });
        observed = yield* waitReady;
      }

      const keys = yield* rootKeys(subscriptionId, resourceGroup, name);
      return toAttrs(resourceGroup, name, observed, keys);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventhub.DeleteNamespace({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          namespaceName: output.namespaceName,
        }),
      );
      yield* waitUntilGone(
        `event hubs namespace ${output.namespaceName}`,
        getNamespace(subscriptionId, output.resourceGroup, output.namespaceName),
        { interval: "5 seconds", times: 72 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.EventHub.Cluster", "Azure.Resources.ResourceGroup"],
    },
  });
