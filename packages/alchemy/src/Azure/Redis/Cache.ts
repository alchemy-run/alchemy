import * as redis from "@distilled.cloud/azure/redis";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  CACHE_BUDGET,
  createCacheName,
  getCache,
  lower,
  waitForCacheIdle,
  whileCacheBusy,
} from "./Common.ts";

export type CacheSkuName = "Basic" | "Standard" | "Premium";

export type CacheIdentityType =
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned, UserAssigned";

/** Managed identity of the cache (e.g. for managed-identity persistence). */
export interface CacheIdentity {
  /** Which identities to attach. */
  type: CacheIdentityType;
  /** ARM resource IDs of user-assigned identities to attach. */
  userAssignedIdentities?: string[];
}

/**
 * Redis server settings. Only the settings you set are managed; Azure
 * keeps its defaults for the rest.
 */
export interface CacheRedisConfiguration {
  /**
   * Eviction policy when memory is full, e.g. `volatile-lru` (the Azure
   * default), `allkeys-lru`, `noeviction`.
   */
  maxmemoryPolicy?: string;
  /** Megabytes reserved per shard for non-cache usage (e.g. failover). */
  maxmemoryReserved?: number;
  /** Megabytes reserved per shard for non-cache usage (e.g. failover). */
  maxmemoryDelta?: number;
  /** Megabytes reserved per shard for memory fragmentation. */
  maxfragmentationmemoryReserved?: number;
  /** Keyspace events to publish, e.g. `KEA`. Empty string disables them. */
  notifyKeyspaceEvents?: string;
  /**
   * Enable Microsoft Entra authentication, required for
   * `Azure.Redis.AccessPolicyAssignment`-style data access with tokens.
   */
  aadEnabled?: boolean;
  /** Enable RDB snapshots to a storage account (Premium only). */
  rdbBackupEnabled?: boolean;
  /** Minutes between RDB snapshots: 15, 30, 60, 360, 720 or 1440 (Premium only). */
  rdbBackupFrequency?: number;
  /** Maximum number of RDB snapshots to keep (Premium only). */
  rdbBackupMaxSnapshotCount?: number;
  /**
   * Storage account connection string for RDB snapshots. Azure never
   * returns it, so it is sent whenever another configuration setting
   * changes and on create, but a change to it alone is not detected.
   */
  rdbStorageConnectionString?: string;
  /** Enable AOF persistence to a storage account (Premium only). */
  aofBackupEnabled?: boolean;
  /** First storage account connection string for AOF persistence. Not read back (see `rdbStorageConnectionString`). */
  aofStorageConnectionString0?: string;
  /** Second storage account connection string for AOF persistence. Not read back (see `rdbStorageConnectionString`). */
  aofStorageConnectionString1?: string;
  /** Auth method for the persistence storage account: `SAS` or `ManagedIdentity`. */
  preferredDataPersistenceAuthMethod?: "SAS" | "ManagedIdentity";
  /** Subscription of the persistence storage account when using a managed identity. */
  storageSubscriptionId?: string;
}

export interface CacheProps {
  /** Resource group the cache is created in. Changing it replaces the cache. */
  resourceGroup: string;
  /**
   * Cache name: 1-63 letters, digits, and single hyphens. It forms the
   * globally unique host name `<name>.redis.cache.windows.net`. If omitted,
   * a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the cache.
   */
  name?: string;
  /**
   * Azure location of the cache. Changing it replaces the cache.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Pricing tier. Scaling up (`Basic` → `Standard` → `Premium`) happens in
   * place; scaling down to a lower tier replaces the cache.
   * @default "Basic"
   */
  sku?: CacheSkuName;
  /**
   * Cache size: 0-6 for `Basic`/`Standard` (C0 250 MB … C6 53 GB), 1-5 for
   * `Premium` (P1 6 GB … P5 120 GB). Changes scale the cache in place.
   * @default 0 for Basic/Standard, 1 for Premium
   */
  capacity?: number;
  /** Availability zones (Standard/Premium). Changing them replaces the cache. */
  zones?: string[];
  /**
   * How zones are allocated: `Automatic`, `UserDefined` (with `zones`), or
   * `NoZones`. Azure picks a value when omitted.
   */
  zonalAllocationPolicy?: "Automatic" | "UserDefined" | "NoZones";
  /**
   * ARM resource ID of a subnet to inject the cache into (Premium only).
   * Changing it replaces the cache.
   */
  subnetId?: string;
  /** Static IP inside `subnetId`. Changing it replaces the cache. */
  staticIP?: string;
  /** Number of shards of a clustered Premium cache. */
  shardCount?: number;
  /** Number of replicas per primary (Premium only). */
  replicasPerPrimary?: number;
  /**
   * Redis major version, e.g. `6`. Versions can only be upgraded.
   * @default "6" (Azure's latest)
   */
  redisVersion?: string;
  /**
   * Allow plain-text connections on port 6379.
   * @default false
   */
  enableNonSslPort?: boolean;
  /**
   * Minimum TLS version accepted by the cache.
   * @default "1.2"
   */
  minimumTlsVersion?: "1.0" | "1.1" | "1.2";
  /**
   * Whether the public endpoint accepts traffic. Set `Disabled` to require
   * private endpoints.
   * @default "Enabled"
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * Monthly Redis update channel; `Preview` gets updates at least 4 weeks
   * earlier.
   * @default "Stable"
   */
  updateChannel?: "Stable" | "Preview";
  /**
   * Disable access-key authentication (Microsoft Entra only).
   * @default false
   */
  disableAccessKeyAuthentication?: boolean;
  /** Redis server settings. */
  redisConfiguration?: CacheRedisConfiguration;
  /** Tenant settings dictionary. */
  tenantSettings?: Record<string, string>;
  /** Managed identity of the cache. Omit for no identity. */
  identity?: CacheIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Cache extends Resource<
  "Azure.Redis.Cache",
  CacheProps,
  {
    /** Name of the cache. */
    cacheName: string;
    /** ARM resource ID of the cache; use it as a role-assignment scope. */
    cacheId: string;
    /** Resource group that holds the cache. */
    resourceGroup: string;
    /** Location of the cache, e.g. `eastus`. */
    location: string;
    /** Pricing tier (`Basic`, `Standard`, `Premium`). */
    sku: string;
    /** SKU family (`C` for Basic/Standard, `P` for Premium). */
    family: string;
    /** Cache size within the tier. */
    capacity: number;
    /** DNS name of the cache, `<name>.redis.cache.windows.net`. */
    hostName: string;
    /** Non-TLS port (6379), only reachable when `enableNonSslPort` is set. */
    port: number | undefined;
    /** TLS port (6380). */
    sslPort: number | undefined;
    /** Redis version the cache runs, e.g. `6.0`. */
    redisVersion: string | undefined;
    /** ARM provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** Primary access key. */
    primaryKey: Redacted.Redacted<string> | undefined;
    /** Secondary access key. */
    secondaryKey: Redacted.Redacted<string> | undefined;
    /** StackExchange.Redis-style connection string over TLS with the primary key. */
    primaryConnectionString: Redacted.Redacted<string> | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Cache for Redis instance (`Microsoft.Cache/redis`) in the
 * Basic, Standard, or Premium tier.
 *
 * Provisioning takes roughly 15-20 minutes (Premium up to ~40); the
 * deploy blocks until the cache is `Succeeded`. For new workloads prefer
 * `Azure.Redis.ManagedRedis`: Microsoft retires these tiers in 2028 and
 * refuses new caches (`RedisCacheRetiring`) to subscriptions that never
 * had one — in practice also in regions where the subscription had none.
 *
 * @see https://learn.microsoft.com/azure/azure-cache-for-redis/cache-overview
 *
 * ### Creating a Cache
 * **Example:** Smallest Basic cache
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const cache = yield* Azure.Redis.Cache("cache", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Standard cache with an eviction policy
 * ```typescript
 * const cache = yield* Azure.Redis.Cache("cache", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Standard",
 *   capacity: 1,
 *   redisConfiguration: { maxmemoryPolicy: "allkeys-lru" },
 *   tags: { team: "platform" },
 * });
 * ```
 *
 * ### Connecting
 * **Example:** Pass the connection string to an app
 * ```typescript
 * const cache = yield* Azure.Redis.Cache("cache", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * // `cache.hostName`, `cache.sslPort`, `cache.primaryKey` (Redacted)
 * const connection = cache.primaryConnectionString;
 * ```
 *
 * ### Microsoft Entra Authentication
 * **Example:** Enable Entra auth and disable access keys
 * ```typescript
 * const cache = yield* Azure.Redis.Cache("cache", {
 *   resourceGroup: group.resourceGroupName,
 *   redisConfiguration: { aadEnabled: true },
 *   disableAccessKeyAuthentication: true,
 * });
 * ```
 *
 * ### Premium Features
 * **Example:** Clustered Premium cache with zone redundancy
 * ```typescript
 * const cache = yield* Azure.Redis.Cache("cache", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Premium",
 *   capacity: 1,
 *   shardCount: 2,
 *   zonalAllocationPolicy: "Automatic",
 * });
 * ```
 *
 * @resource
 */
export const Cache = Resource<Cache>("Azure.Redis.Cache");

type ObservedCache = redis.GetRedisResponse;
type WireConfiguration = redis.RedisCommonPropertiesRedisConfigurationInput;

const TIER_RANK: Record<string, number> = { basic: 0, standard: 1, premium: 2 };

const armLocation = (location: string) =>
  location.replace(/\s+/g, "").toLowerCase();

const familyOf = (sku: string) => (sku === "Premium" ? "P" : "C");

const toSku = (news: CacheProps) => {
  const name = news.sku ?? "Basic";
  return {
    name,
    family: familyOf(name),
    capacity: news.capacity ?? (name === "Premium" ? 1 : 0),
  };
};

const toAttrs = (
  resourceGroup: string,
  name: string,
  cache: ObservedCache | redis.RedisResource,
  keys: redis.RedisAccessKeys | undefined,
): Cache["Attributes"] => {
  const host = cache.properties.hostName ?? "";
  const sslPort = cache.properties.sslPort ?? undefined;
  return {
    cacheName: name,
    cacheId: cache.id ?? "",
    resourceGroup,
    // Azure reports the display name (`East US`); keep the ARM form.
    location: armLocation(cache.location),
    sku: cache.properties.sku.name,
    family: cache.properties.sku.family,
    capacity: cache.properties.sku.capacity,
    hostName: host,
    port: cache.properties.port ?? undefined,
    sslPort,
    redisVersion: cache.properties.redisVersion ?? undefined,
    provisioningState: cache.properties.provisioningState ?? undefined,
    principalId: cache.identity?.principalId ?? undefined,
    primaryKey: keys?.primaryKey ? Redacted.make(keys.primaryKey) : undefined,
    secondaryKey: keys?.secondaryKey
      ? Redacted.make(keys.secondaryKey)
      : undefined,
    primaryConnectionString: keys?.primaryKey
      ? Redacted.make(
          `${host}:${sslPort ?? 6380},password=${keys.primaryKey},ssl=True,abortConnect=False`,
        )
      : undefined,
    tags: userTags(cache.tags),
  };
};

const flag = (value: boolean | undefined) =>
  value === undefined ? undefined : value ? "true" : "false";
const num = (value: number | undefined) =>
  value === undefined ? undefined : String(value);

/** Desired settings in wire form; connection strings are kept apart. */
const toConfiguration = (config: CacheRedisConfiguration | undefined) => {
  const c = config ?? {};
  const compared: WireConfiguration = {
    maxmemory_policy: c.maxmemoryPolicy,
    maxmemory_reserved: num(c.maxmemoryReserved),
    maxmemory_delta: num(c.maxmemoryDelta),
    maxfragmentationmemory_reserved: num(c.maxfragmentationmemoryReserved),
    notify_keyspace_events: c.notifyKeyspaceEvents,
    aad_enabled: flag(c.aadEnabled),
    rdb_backup_enabled: flag(c.rdbBackupEnabled),
    rdb_backup_frequency: num(c.rdbBackupFrequency),
    rdb_backup_max_snapshot_count: num(c.rdbBackupMaxSnapshotCount),
    aof_backup_enabled: flag(c.aofBackupEnabled),
    preferred_data_persistence_auth_method:
      c.preferredDataPersistenceAuthMethod,
    storage_subscription_id: c.storageSubscriptionId,
  };
  const secrets: WireConfiguration = {
    rdb_storage_connection_string: c.rdbStorageConnectionString,
    aof_storage_connection_string_0: c.aofStorageConnectionString0,
    aof_storage_connection_string_1: c.aofStorageConnectionString1,
  };
  const strip = (value: WireConfiguration) =>
    Object.fromEntries(
      Object.entries(value).filter(([, v]) => v !== undefined),
    ) as WireConfiguration;
  return { compared: strip(compared), secrets: strip(secrets) };
};

const configurationDiffers = (
  desired: WireConfiguration,
  observed: redis.RedisCommonPropertiesRedisConfiguration | undefined,
) =>
  Object.entries(desired).some(
    ([key, value]) =>
      lower(String(value)) !==
      lower((observed as Record<string, string | undefined> | undefined)?.[key]),
  );

const toIdentity = (identity: CacheIdentity | undefined) =>
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
  desired: CacheIdentity | undefined,
  observed: ObservedCache["identity"],
) => {
  const normalize = (type: string | undefined) =>
    (type ?? "None").replace(/\s/g, "").toLowerCase();
  if (normalize(observed?.type) !== normalize(desired?.type)) return false;
  const left = (desired?.userAssignedIdentities ?? [])
    .map((id) => id.toLowerCase())
    .sort();
  const right = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  return left.length === right.length && left.every((id, i) => id === right[i]);
};

const sameStrings = (a: string[] | undefined, b: string[] | undefined) => {
  const left = [...(a ?? [])].sort();
  const right = [...(b ?? [])].sort();
  return left.length === right.length && left.every((z, i) => z === right[i]);
};

const sameRecord = (
  desired: Record<string, string>,
  observed: Record<string, string | undefined> | undefined,
) => {
  const keys = Object.keys(desired);
  return (
    keys.length === Object.keys(observed ?? {}).length &&
    keys.every((key) => observed?.[key] === desired[key])
  );
};

const listKeys = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    redis.ListRedisKeys({ subscriptionId, resourceGroupName, name }),
  );

export const CacheProvider = () =>
  Provider.succeed(Cache, {
    stables: ["cacheName", "cacheId", "resourceGroup", "location", "hostName"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* redis
        .ListRedisBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListRedisBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((cache) => {
        const group = resourceGroupOf(cache.id);
        return hasAnyAlchemyTag(cache.tags) &&
          group !== undefined &&
          cache.name !== undefined
          ? [toAttrs(group, cache.name, cache, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const sku = news.sku ?? "Basic";
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.cacheName)) ||
        (news.location !== undefined &&
          armLocation(news.location) !== armLocation(output.location)) ||
        // Scaling down a tier is rejected; only upgrades happen in place.
        (TIER_RANK[sku.toLowerCase()] ?? 0) <
          (TIER_RANK[output.sku.toLowerCase()] ?? 0) ||
        (olds !== undefined &&
          (!sameStrings(news.zones, olds.zones) ||
            lower(news.subnetId) !== lower(olds.subnetId) ||
            news.staticIP !== olds.staticIP))
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
        output?.cacheName ?? olds?.name ?? (yield* createCacheName(id));
      const observed = yield* getCache(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const keys = yield* listKeys(subscriptionId, resourceGroup, name);
      const attrs = toAttrs(resourceGroup, name, observed, keys);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Cache");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.cacheName ?? (yield* createCacheName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const sku = toSku(news);
      const configuration = toConfiguration(news.redisConfiguration);
      const desired = {
        enableNonSslPort: news.enableNonSslPort ?? false,
        minimumTlsVersion: news.minimumTlsVersion ?? "1.2",
        publicNetworkAccess: news.publicNetworkAccess ?? "Enabled",
        updateChannel: news.updateChannel ?? "Stable",
        disableAccessKeyAuthentication:
          news.disableAccessKeyAuthentication ?? false,
      };
      const where = { subscriptionId, resourceGroupName: resourceGroup, name };

      // Observe.
      let observed = yield* getCache(subscriptionId, resourceGroup, name);

      // Ensure. Creation is long-running (15-40 minutes).
      if (observed === undefined) {
        yield* redis
          .CreateRedis({
            ...where,
            location,
            zones: news.zones,
            tags,
            identity: news.identity ? toIdentity(news.identity) : undefined,
            properties: {
              ...desired,
              sku,
              redisVersion: news.redisVersion,
              shardCount: news.shardCount,
              replicasPerPrimary: news.replicasPerPrimary,
              zonalAllocationPolicy: news.zonalAllocationPolicy,
              subnetId: news.subnetId,
              staticIP: news.staticIP,
              tenantSettings: news.tenantSettings,
              redisConfiguration:
                Object.keys(configuration.compared).length +
                  Object.keys(configuration.secrets).length >
                0
                  ? { ...configuration.compared, ...configuration.secrets }
                  : undefined,
            },
          })
          .pipe(Effect.retry(whileCacheBusy));
      }
      observed = yield* waitForCacheIdle(subscriptionId, resourceGroup, name);

      // Sync each mutable aspect against observed state; a cache processes
      // one update at a time, so all deltas go in one PATCH.
      const props = observed.properties;
      const changed: redis.RedisUpdatePropertiesInput = {};
      if (props.enableNonSslPort !== desired.enableNonSslPort) {
        changed.enableNonSslPort = desired.enableNonSslPort;
      }
      if ((props.minimumTlsVersion ?? "1.2") !== desired.minimumTlsVersion) {
        changed.minimumTlsVersion = desired.minimumTlsVersion;
      }
      if (
        (props.publicNetworkAccess ?? "Enabled") !== desired.publicNetworkAccess
      ) {
        changed.publicNetworkAccess = desired.publicNetworkAccess;
      }
      if ((props.updateChannel ?? "Stable") !== desired.updateChannel) {
        changed.updateChannel = desired.updateChannel;
      }
      if (
        (props.disableAccessKeyAuthentication ?? false) !==
        desired.disableAccessKeyAuthentication
      ) {
        changed.disableAccessKeyAuthentication =
          desired.disableAccessKeyAuthentication;
      }
      if (
        props.sku.name !== sku.name ||
        props.sku.family !== sku.family ||
        props.sku.capacity !== sku.capacity
      ) {
        changed.sku = sku;
      }
      if (
        news.shardCount !== undefined &&
        props.shardCount !== news.shardCount
      ) {
        changed.shardCount = news.shardCount;
      }
      if (
        news.replicasPerPrimary !== undefined &&
        props.replicasPerPrimary !== news.replicasPerPrimary
      ) {
        changed.replicasPerPrimary = news.replicasPerPrimary;
      }
      if (
        news.redisVersion !== undefined &&
        !(props.redisVersion ?? "").startsWith(news.redisVersion)
      ) {
        changed.redisVersion = news.redisVersion;
      }
      if (
        news.zonalAllocationPolicy !== undefined &&
        props.zonalAllocationPolicy !== news.zonalAllocationPolicy
      ) {
        changed.zonalAllocationPolicy = news.zonalAllocationPolicy;
      }
      if (
        news.tenantSettings !== undefined &&
        !sameRecord(news.tenantSettings, props.tenantSettings)
      ) {
        changed.tenantSettings = news.tenantSettings;
      }
      if (configurationDiffers(configuration.compared, props.redisConfiguration)) {
        changed.redisConfiguration = {
          ...configuration.compared,
          ...configuration.secrets,
        };
      }
      const identityChanged = !sameIdentity(news.identity, observed.identity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(changed).length > 0 || identityChanged || tagsChanged) {
        yield* redis
          .UpdateRedis({
            ...where,
            properties: Object.keys(changed).length > 0 ? changed : undefined,
            identity: identityChanged ? toIdentity(news.identity) : undefined,
            tags: tagsChanged ? tags : undefined,
          })
          .pipe(Effect.retry(whileCacheBusy));
        observed = yield* waitForCacheIdle(subscriptionId, resourceGroup, name);
      }

      const keys = yield* listKeys(subscriptionId, resourceGroup, name);
      return toAttrs(resourceGroup, name, observed, keys);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        redis
          .DeleteRedis({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            name: output.cacheName,
          })
          .pipe(Effect.retry(whileCacheBusy)),
      );
      yield* waitUntilGone(
        `redis cache ${output.cacheName}`,
        getCache(subscriptionId, output.resourceGroup, output.cacheName),
        CACHE_BUDGET,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
