import * as redisenterprise from "@distilled.cloud/azure/redisenterprise";
import * as Effect from "effect/Effect";
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
import { createClusterName, getCluster, lower, readiness } from "./Common.ts";

export type ManagedRedisSkuName = redisenterprise.SkuName;

export type ManagedRedisIdentityType =
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned, UserAssigned";

/** Managed identity of the cluster (e.g. for customer-managed keys). */
export interface ManagedRedisIdentity {
  /** Which identities to attach. */
  type: ManagedRedisIdentityType;
  /** ARM resource IDs of user-assigned identities to attach. */
  userAssignedIdentities?: string[];
}

/** Customer-managed key encryption at rest. */
export interface ManagedRedisCustomerManagedKey {
  /** Versioned Key Vault key URL, e.g. `https://vault.vault.azure.net/keys/kek/<version>`. */
  keyEncryptionKeyUrl: string;
  /** ARM resource ID of the user-assigned identity that can read the key. */
  userAssignedIdentityId: string;
}

export interface ManagedRedisProps {
  /** Resource group the cluster is created in. Changing it replaces the cluster. */
  resourceGroup: string;
  /**
   * Cluster name: letters, digits, and single hyphens; together with the
   * location's display name (e.g. `East US`) at most 62 characters. It
   * forms the host name `<name>.<region>.redis.azure.net`. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the cluster.
   */
  name?: string;
  /**
   * Azure location of the cluster. Changing it replaces the cluster.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Performance tier and size (`Balanced_B*`, `MemoryOptimized_M*`,
   * `ComputeOptimized_X*`, `FlashOptimized_A*`). Scaling within Azure
   * Managed Redis tiers happens in place; moving between the Azure Managed
   * Redis tiers and the legacy `Enterprise_*` / `EnterpriseFlash_*` SKUs
   * replaces the cluster.
   * @default "Balanced_B0"
   */
  sku?: ManagedRedisSkuName;
  /**
   * Cluster size for the legacy `Enterprise_*` (2, 4, 6, ...) and
   * `EnterpriseFlash_*` (3, 9, 15, ...) SKUs. Ignored by Azure Managed Redis
   * SKUs.
   */
  capacity?: number;
  /** Availability zones the cluster is deployed in. Changing them replaces the cluster. */
  zones?: string[];
  /**
   * Replicate the data set across nodes. Disabling it halves the cost but
   * removes the availability SLA and risks data loss.
   * @default "Enabled"
   */
  highAvailability?: "Enabled" | "Disabled";
  /**
   * Minimum TLS version accepted by the cluster.
   * @default "1.2"
   */
  minimumTlsVersion?: "1.2";
  /**
   * Whether the public endpoint accepts traffic. Set `Disabled` to require
   * private endpoints.
   * @default "Enabled"
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * Managed identity of the cluster. Omit for no identity.
   */
  identity?: ManagedRedisIdentity;
  /**
   * Customer-managed key encryption at rest. Omit for Microsoft-managed
   * keys. Requires the identity to be attached via `identity`.
   */
  customerManagedKey?: ManagedRedisCustomerManagedKey;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ManagedRedis extends Resource<
  "Azure.Redis.ManagedRedis",
  ManagedRedisProps,
  {
    /** Name of the cluster. */
    clusterName: string;
    /** ARM resource ID of the cluster; use it as a role-assignment scope. */
    clusterId: string;
    /** Resource group that holds the cluster. */
    resourceGroup: string;
    /** Location of the cluster, e.g. `westus2`. */
    location: string;
    /** SKU name. */
    sku: string;
    /** DNS name of the cluster endpoint, e.g. `<name>.<region>.redis.azure.net`. */
    hostName: string;
    /** Redis version the cluster runs, e.g. `7.4`. */
    redisVersion: string | undefined;
    /** Data-plane state of the cluster, e.g. `Running`. */
    resourceState: string | undefined;
    /** Redundancy of the cluster (`None`, `LR`, `ZR`). */
    redundancyMode: string | undefined;
    /** Whether the data set is replicated. */
    highAvailability: string | undefined;
    /** Whether the public endpoint accepts traffic. */
    publicNetworkAccess: string | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Managed Redis cluster (`Microsoft.Cache/redisEnterprise`) — the
 * successor of Azure Cache for Redis. A cluster holds one database; create
 * it with `Azure.Redis.ManagedRedisDatabase`.
 *
 * Provisioning takes roughly 5-10 minutes; the deploy blocks until the
 * cluster is `Running`.
 *
 * @see https://learn.microsoft.com/azure/redis/overview
 *
 * ### Creating a Cluster
 * **Example:** Smallest Balanced cluster
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const redis = yield* Azure.Redis.ManagedRedis("cache", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Balanced_B0",
 *   highAvailability: "Disabled",
 * });
 * ```
 *
 * **Example:** Highly available Memory Optimized cluster
 * ```typescript
 * const redis = yield* Azure.Redis.ManagedRedis("cache", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "MemoryOptimized_M10",
 *   tags: { team: "platform" },
 * });
 * ```
 *
 * ### Private Networking
 * **Example:** Disable the public endpoint
 * ```typescript
 * const redis = yield* Azure.Redis.ManagedRedis("cache", {
 *   resourceGroup: group.resourceGroupName,
 *   publicNetworkAccess: "Disabled",
 * });
 * ```
 *
 * ### Managed Identity
 * **Example:** Customer-managed key with a user-assigned identity
 * ```typescript
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("redis", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const redis = yield* Azure.Redis.ManagedRedis("cache", {
 *   resourceGroup: group.resourceGroupName,
 *   identity: {
 *     type: "UserAssigned",
 *     userAssignedIdentities: [identity.identityId],
 *   },
 *   customerManagedKey: {
 *     keyEncryptionKeyUrl: "https://vault.vault.azure.net/keys/kek/0123456789abcdef",
 *     userAssignedIdentityId: identity.identityId,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const ManagedRedis = Resource<ManagedRedis>("Azure.Redis.ManagedRedis");

type ObservedCluster = redisenterprise.GetRedisEnterpriseResponse;

const LEGACY_SKU = /^Enterprise(Flash)?_/;

const armLocation = (location: string) =>
  location.replace(/\s+/g, "").toLowerCase();

const toAttrs = (
  resourceGroup: string,
  name: string,
  cluster: ObservedCluster,
): ManagedRedis["Attributes"] => ({
  clusterName: name,
  clusterId: cluster.id ?? "",
  resourceGroup,
  // Azure reports the display name (`West US 2`); keep the ARM form.
  location: armLocation(cluster.location),
  sku: cluster.sku?.name ?? "",
  hostName: cluster.properties?.hostName ?? "",
  redisVersion: cluster.properties?.redisVersion,
  resourceState: cluster.properties?.resourceState,
  redundancyMode: cluster.properties?.redundancyMode,
  highAvailability: cluster.properties?.highAvailability,
  publicNetworkAccess: cluster.properties?.publicNetworkAccess ?? undefined,
  principalId: cluster.identity?.principalId,
  tags: userTags(cluster.tags),
});

const toIdentity = (identity: ManagedRedisIdentity | undefined) =>
  identity === undefined
    ? { type: "None" }
    : {
        type: identity.type,
        userAssignedIdentities:
          identity.userAssignedIdentities === undefined
            ? undefined
            : Object.fromEntries(
                identity.userAssignedIdentities.map((id) => [id, {}]),
              ),
      };

const sameIdentity = (
  desired: ManagedRedisIdentity | undefined,
  observed: ObservedCluster["identity"],
) => {
  const observedType = observed?.type ?? "None";
  const desiredType = desired?.type ?? "None";
  if (
    observedType.replace(/\s/g, "").toLowerCase() !==
    desiredType.replace(/\s/g, "").toLowerCase()
  ) {
    return false;
  }
  const left = (desired?.userAssignedIdentities ?? [])
    .map((id) => id.toLowerCase())
    .sort();
  const right = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  return left.length === right.length && left.every((id, i) => id === right[i]);
};

const toEncryption = (key: ManagedRedisCustomerManagedKey | undefined) => ({
  customerManagedKeyEncryption:
    key === undefined
      ? {}
      : {
          keyEncryptionKeyUrl: key.keyEncryptionKeyUrl,
          keyEncryptionKeyIdentity: {
            identityType: "userAssignedIdentity",
            userAssignedIdentityResourceId: key.userAssignedIdentityId,
          },
        },
});

const sameEncryption = (
  desired: ManagedRedisCustomerManagedKey | undefined,
  observed: NonNullable<ObservedCluster["properties"]>["encryption"],
) => {
  const cmk = observed?.customerManagedKeyEncryption;
  return (
    lower(desired?.keyEncryptionKeyUrl) === lower(cmk?.keyEncryptionKeyUrl) &&
    lower(desired?.userAssignedIdentityId) ===
      lower(cmk?.keyEncryptionKeyIdentity?.userAssignedIdentityResourceId)
  );
};

const sameZones = (a: string[] | undefined, b: string[] | undefined) => {
  const left = [...(a ?? [])].sort();
  const right = [...(b ?? [])].sort();
  return (
    left.length === right.length && left.every((zone, i) => zone === right[i])
  );
};

// Provisioning a cluster takes 5-10 minutes (up to ~15 for large SKUs).
const PROVISION_BUDGET = { interval: "15 seconds", times: 60 } as const;

export const ManagedRedisProvider = () =>
  Provider.succeed(ManagedRedis, {
    stables: ["clusterName", "clusterId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* redisenterprise
        .ListRedisEnterprise({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListRedisEnterprise", page),
          ),
        );
      return (page.value ?? []).flatMap((cluster) => {
        const group = resourceGroupOf(cluster.id);
        return hasAnyAlchemyTag(cluster.tags) &&
          group !== undefined &&
          cluster.name !== undefined
          ? [toAttrs(group, cluster.name, cluster)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const sku = news.sku ?? "Balanced_B0";
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.clusterName)) ||
        (news.location !== undefined &&
          armLocation(news.location) !== armLocation(output.location)) ||
        LEGACY_SKU.test(sku) !== LEGACY_SKU.test(output.sku) ||
        (olds !== undefined && !sameZones(news.zones, olds.zones))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.clusterName ?? olds?.name ?? (yield* createClusterName(id));
      const observed = yield* getCluster(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Cache");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.clusterName ?? (yield* createClusterName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const sku = {
        name: news.sku ?? "Balanced_B0",
        capacity: news.capacity,
      };
      const desired = {
        highAvailability: news.highAvailability ?? "Enabled",
        minimumTlsVersion: news.minimumTlsVersion ?? "1.2",
        publicNetworkAccess: news.publicNetworkAccess ?? "Enabled",
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: name,
      };
      const label = `managed redis ${name}`;
      const get = getCluster(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation; the cluster accepts
      // data-plane traffic once `resourceState` is `Running`.
      if (observed === undefined) {
        yield* redisenterprise.CreateRedisEnterprise({
          ...where,
          location,
          sku,
          zones: news.zones,
          tags,
          identity: news.identity ? toIdentity(news.identity) : undefined,
          properties: {
            ...desired,
            encryption: news.customerManagedKey
              ? toEncryption(news.customerManagedKey)
              : undefined,
          },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        readiness,
        PROVISION_BUDGET,
      );

      // Sync each mutable aspect against observed state; PATCH only deltas.
      // The cluster rejects concurrent updates, so all deltas go in one PATCH.
      const props = observed.properties;
      const changed: redisenterprise.ClusterUpdatePropertiesInput = {};
      if (props?.highAvailability !== desired.highAvailability) {
        changed.highAvailability = desired.highAvailability;
      }
      if (props?.minimumTlsVersion !== desired.minimumTlsVersion) {
        changed.minimumTlsVersion = desired.minimumTlsVersion;
      }
      if (props?.publicNetworkAccess !== desired.publicNetworkAccess) {
        changed.publicNetworkAccess = desired.publicNetworkAccess;
      }
      if (!sameEncryption(news.customerManagedKey, props?.encryption)) {
        changed.encryption = toEncryption(news.customerManagedKey);
      }
      const skuChanged =
        observed.sku?.name !== sku.name ||
        (sku.capacity !== undefined && observed.sku?.capacity !== sku.capacity);
      const identityChanged = !sameIdentity(news.identity, observed.identity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (
        Object.keys(changed).length > 0 ||
        skuChanged ||
        identityChanged ||
        tagsChanged
      ) {
        yield* redisenterprise.UpdateRedisEnterprise({
          ...where,
          sku: skuChanged ? sku : undefined,
          identity: identityChanged ? toIdentity(news.identity) : undefined,
          tags: tagsChanged ? tags : undefined,
          properties: Object.keys(changed).length > 0 ? changed : undefined,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          readiness,
          PROVISION_BUDGET,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        redisenterprise.DeleteRedisEnterprise({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.clusterName,
        }),
      );
      yield* waitUntilGone(
        `managed redis ${output.clusterName}`,
        getCluster(subscriptionId, output.resourceGroup, output.clusterName),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
