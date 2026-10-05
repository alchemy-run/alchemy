import * as eventhub from "@distilled.cloud/azure/eventhub";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createNamespaceName, getNamespace, toKeys } from "./Common.ts";

export type NamespaceSkuName = "Basic" | "Standard" | "Premium";
export type NamespaceTlsVersion = "1.0" | "1.1" | "1.2" | "1.3";

export interface NamespaceProps {
  /** Resource group the namespace is created in. Changing it replaces the namespace. */
  resourceGroup: string;
  /**
   * Globally unique namespace name (`{name}.servicebus.windows.net`): 6-50
   * letters, digits, and hyphens, starting with a letter and ending with a
   * letter or digit. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the namespace.
   */
  name?: string;
  /**
   * Azure location of the namespace. Changing it replaces the namespace.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Pricing tier. `Basic` allows only the `$Default` consumer group and
   * 1-day retention; `Standard` adds consumer groups, Kafka, Capture,
   * schema registry, and IP firewall rules. Moving between `Basic` and
   * `Standard` happens in place; moving to or from `Premium` replaces the
   * namespace.
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
   * Spread the namespace across availability zones. Set only at creation;
   * changing it replaces the namespace.
   */
  zoneRedundant?: boolean;
  /**
   * ARM ID of a dedicated Event Hubs cluster to place the namespace in.
   * Changing it replaces the namespace.
   */
  clusterArmId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
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
 * An Azure Event Hubs namespace — the container and DNS endpoint
 * (`{name}.servicebus.windows.net`) for event hubs, consumer groups, and
 * shared access policies.
 *
 * @see https://learn.microsoft.com/azure/event-hubs/event-hubs-features
 *
 * ### Creating a Namespace
 * **Example:** Standard namespace
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const namespace = yield* Azure.EventHub.Namespace("events", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Cheapest Basic namespace
 * ```typescript
 * const namespace = yield* Azure.EventHub.Namespace("events", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Basic",
 * });
 * ```
 *
 * ### Scaling
 * **Example:** Auto-inflate throughput units
 * ```typescript
 * const namespace = yield* Azure.EventHub.Namespace("events", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Standard",
 *   capacity: 2,
 *   isAutoInflateEnabled: true,
 *   maximumThroughputUnits: 10,
 * });
 * ```
 *
 * ### Entra ID Only
 * **Example:** Disable shared access keys
 * ```typescript
 * const namespace = yield* Azure.EventHub.Namespace("events", {
 *   resourceGroup: group.resourceGroupName,
 *   disableLocalAuth: true,
 * });
 * ```
 *
 * @resource
 */
export const Namespace = Resource<Namespace>("Azure.EventHub.Namespace");

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

const rootKeys = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
) =>
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
      const page = yield* eventhub
        .ListNamespaces({ subscriptionId })
        .pipe(
          Effect.flatMap((page) => requireSinglePage("ListNamespaces", page)),
        );
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
        (news.name !== undefined &&
          lower(news.name) !== lower(output.namespaceName)) ||
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
      const name =
        output?.namespaceName ??
        olds?.name ??
        (yield* createNamespaceName(id));
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
      const name =
        news.name ?? output?.namespaceName ?? (yield* createNamespaceName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const sku = { name: news.sku ?? "Standard", capacity: news.capacity ?? 1 };
      const desired = {
        minimumTlsVersion: news.minimumTlsVersion ?? "1.2",
        publicNetworkAccess: news.publicNetworkAccess,
        disableLocalAuth: news.disableLocalAuth,
        isAutoInflateEnabled:
          sku.name === "Standard"
            ? (news.isAutoInflateEnabled ?? false)
            : undefined,
        maximumThroughputUnits: news.isAutoInflateEnabled
          ? news.maximumThroughputUnits
          : undefined,
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
