import * as redis from "@distilled.cloud/azure/redis";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  CACHE_BUDGET,
  createCacheName,
  getCache,
  lower,
  waitForCacheIdle,
  whileCacheBusy,
} from "./Common.ts";

export type CacheSkuName = "Basic" | "Standard" | "Premium";

export type CacheIdentityType = "SystemAssigned" | "UserAssigned" | "SystemAssigned, UserAssigned";

/** Managed identity of the cache (e.g. for managed-identity persistence). */
export interface CacheIdentity {
  /** Which identities to attach. */
  type: CacheIdentityType;
  /**
   * ARM resource IDs of user-assigned identities to attach.
   * @default []
   */
  userAssignedIdentities?: string[];
}

/**
 * Redis server settings. Only the settings you set are managed; Azure
 * keeps its defaults for the rest.
 */
export interface CacheRedisConfiguration {
  /**
   * Eviction policy when memory is full, e.g. `volatile-lru`,
   * `allkeys-lru`, `noeviction`.
   * @default Azure's default (`volatile-lru`)
   */
  maxmemoryPolicy?: string;
  /**
   * Megabytes reserved per shard for non-cache usage (e.g. failover).
   * @default Azure's default for the size
   */
  maxmemoryReserved?: number;
  /**
   * Megabytes reserved per shard for non-cache usage (e.g. failover).
   * @default Azure's default for the size
   */
  maxmemoryDelta?: number;
  /**
   * Megabytes reserved per shard for memory fragmentation.
   * @default Azure's default for the size
   */
  maxfragmentationmemoryReserved?: number;
  /**
   * Keyspace events to publish, e.g. `KEA`. An empty string disables them.
   * @default Azure's default (disabled)
   */
  notifyKeyspaceEvents?: string;
  /**
   * Enable Microsoft Entra authentication, required for
   * `Azure.Redis.CacheAccessPolicyAssignment` data access with tokens.
   * @default false
   */
  aadEnabled?: boolean;
  /**
   * Enable RDB snapshots to a storage account (Premium only).
   * @default false
   */
  rdbBackupEnabled?: boolean;
  /**
   * Minutes between RDB snapshots: 15, 30, 60, 360, 720, or 1440 (Premium
   * only).
   * @default Azure's default
   */
  rdbBackupFrequency?: number;
  /**
   * Maximum number of RDB snapshots to keep (Premium only).
   * @default Azure's default
   */
  rdbBackupMaxSnapshotCount?: number;
  /**
   * Storage account connection string for RDB snapshots. Azure never
   * returns it, so Alchemy sends it on create and whenever another
   * configuration setting changes; a change to it alone is not detected.
   * @default none
   */
  rdbStorageConnectionString?: string;
  /**
   * Enable AOF persistence to a storage account (Premium only).
   * @default false
   */
  aofBackupEnabled?: boolean;
  /**
   * First storage account connection string for AOF persistence. Not read
   * back (see `rdbStorageConnectionString`).
   * @default none
   */
  aofStorageConnectionString0?: string;
  /**
   * Second storage account connection string for AOF persistence. Not read
   * back (see `rdbStorageConnectionString`).
   * @default none
   */
  aofStorageConnectionString1?: string;
  /**
   * Auth method for the persistence storage account: `SAS` or
   * `ManagedIdentity`.
   * @default Azure's default (`SAS`)
   */
  preferredDataPersistenceAuthMethod?: "SAS" | "ManagedIdentity";
  /**
   * Subscription of the persistence storage account when using a managed
   * identity.
   * @default the cache's subscription
   */
  storageSubscriptionId?: string;
}

export interface CacheProps {
  /**
   * Resource group the cache is created in.
   *
   * :::caution
   * Changing it replaces the cache and deletes its data.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Cache name: 1-63 letters, digits, and single hyphens. It forms the
   * globally unique host name `<name>.redis.cache.windows.net`.
   *
   * :::caution
   * Changing it replaces the cache and deletes its data.
   * :::
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location of the cache.
   *
   * :::caution
   * Changing it replaces the cache and deletes its data.
   * :::
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Pricing tier. Scaling up (`Basic` → `Standard` → `Premium`) happens in
   * place.
   *
   * :::caution
   * Scaling down to a lower tier replaces the cache and deletes its data.
   * :::
   * @default "Basic"
   */
  sku?: CacheSkuName;
  /**
   * Cache size: 0-6 for `Basic`/`Standard` (C0 250 MB … C6 53 GB), 1-5 for
   * `Premium` (P1 6 GB … P5 120 GB). Changes scale the cache in place.
   * @default 0 for Basic/Standard, 1 for Premium
   */
  capacity?: number;
  /**
   * Availability zones (Standard/Premium), e.g. `["1", "2"]`.
   *
   * :::caution
   * Changing them replaces the cache and deletes its data.
   * :::
   * @default none
   */
  zones?: string[];
  /**
   * How zones are allocated: `Automatic`, `UserDefined` (with `zones`), or
   * `NoZones`.
   * @default Azure's choice
   */
  zonalAllocationPolicy?: "Automatic" | "UserDefined" | "NoZones";
  /**
   * ARM resource ID of a subnet to inject the cache into (Premium only).
   *
   * :::caution
   * Changing it replaces the cache and deletes its data.
   * :::
   * @default none (public endpoint)
   */
  subnetId?: string;
  /**
   * Static IP inside `subnetId`.
   *
   * :::caution
   * Changing it replaces the cache and deletes its data.
   * :::
   * @default an address Azure picks
   */
  staticIP?: string;
  /**
   * Number of shards of a clustered Premium cache. Changes reshard in
   * place.
   * @default not clustered
   */
  shardCount?: number;
  /**
   * Number of replicas per primary (Premium only).
   * @default Azure's default (`1`)
   */
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
  /**
   * Redis server settings.
   * @default Azure's defaults
   */
  redisConfiguration?: CacheRedisConfiguration;
  /**
   * Tenant settings dictionary.
   * @default {}
   */
  tenantSettings?: Record<string, string>;
  /**
   * Managed identity of the cache.
   * @default no identity
   */
  identity?: CacheIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
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
 * Basic, Standard, or Premium tier: an in-memory key-value store for
 * caching, sessions, and queues.
 *
 * Alchemy creates a Basic C0 cache (250 MB, no replica) by default, with
 * TLS 1.2 as the minimum version and the plain-text port closed. Clients
 * connect on port 6380 with an access key, or with a Microsoft Entra token
 * when you enable `aadEnabled`. Creating a cache takes about 15-20 minutes
 * (Premium up to about 40); the deploy waits until it is `Succeeded`.
 *
 * :::caution[Prefer `Azure.Redis.ManagedRedis` for new workloads]
 * Microsoft retires these tiers in 2028 and refuses new caches
 * (`RedisCacheRetiring`) to subscriptions that never had one, in practice
 * also in regions where the subscription had none.
 * :::
 *
 * :::caution[Changing `name`, `location`, `zones`, `subnetId`, `staticIP`, or `resourceGroup` replaces the cache]
 * Alchemy creates a new, empty cache and deletes the old one with its data.
 * Moving to a lower `sku` tier replaces it too; moving up happens in place.
 * :::
 *
 * See [What is Azure Cache for Redis?](https://learn.microsoft.com/azure/azure-cache-for-redis/cache-overview).
 *
 * ### Creating a Cache
 * **Example:** Smallest Basic cache
 * ```typescript
 * const cache = yield* Azure.Redis.Cache("Cache");
 * // cache.hostName → "<name>.redis.cache.windows.net", cache.sslPort → 6380
 * ```
 *
 * **Example:** Standard cache with an eviction policy
 * ```typescript
 * const cache = yield* Azure.Redis.Cache("Cache", {
 *   sku: "Standard",
 *   capacity: 1,
 *   redisConfiguration: { maxmemoryPolicy: "allkeys-lru" },
 *   tags: { team: "platform" },
 * });
 * ```
 *
 * ### Scaling
 * Change `capacity`, or move to a higher `sku`, and deploy again. Azure
 * scales the cache in place and keeps the data.
 *
 * **Example:** Scale a Standard C1 cache up to Premium P1
 * ```diff
 * const cache = yield* Azure.Redis.Cache("Cache", {
 * -  sku: "Standard",
 * +  sku: "Premium",
 *   capacity: 1,
 * });
 * ```
 *
 * ### Microsoft Entra Authentication
 * **Example:** Entra-only cache with a data access policy for an identity
 * ```typescript
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("App");
 * const cache = yield* Azure.Redis.Cache("Cache", {
 *   redisConfiguration: { aadEnabled: true },
 *   disableAccessKeyAuthentication: true,
 * });
 * yield* Azure.Redis.CacheAccessPolicyAssignment("AppAccess", {
 *   cache: cache.cacheName,
 *   accessPolicyName: "Data Contributor",
 *   objectId: identity.principalId,
 * });
 * ```
 *
 * **Example:** Custom access policy limited to session keys
 * ```typescript
 * const sessions = yield* Azure.Redis.AccessPolicy("Sessions", {
 *   cache: cache.cacheName,
 *   permissions: "+@read +@write +@connection ~session:*",
 * });
 * yield* Azure.Redis.CacheAccessPolicyAssignment("SessionsAccess", {
 *   cache: cache.cacheName,
 *   accessPolicyName: sessions.accessPolicyName,
 *   objectId: identity.principalId,
 * });
 * ```
 *
 * ### Network Access
 * **Example:** Allow one IP range through the firewall
 * ```typescript
 * yield* Azure.Redis.FirewallRule("Office", {
 *   cache: cache.cacheName,
 *   startIP: "203.0.113.0",
 *   endIP: "203.0.113.255",
 * });
 * ```
 *
 * **Example:** Private-only cache behind a private endpoint
 * ```typescript
 * const cache = yield* Azure.Redis.Cache("Cache", {
 *   sku: "Standard",
 *   capacity: 1,
 *   publicNetworkAccess: "Disabled",
 * });
 * yield* Azure.Network.PrivateEndpoint("CacheEndpoint", {
 *   subnetId: subnet.subnetId,
 *   privateLinkServiceConnections: [
 *     { privateLinkServiceId: cache.cacheId, groupIds: ["redisCache"] },
 *   ],
 * });
 * ```
 *
 * ### Premium Features
 * **Example:** Clustered, zone-redundant cache with two replicas
 * ```typescript
 * const cache = yield* Azure.Redis.Cache("Cache", {
 *   sku: "Premium",
 *   capacity: 1,
 *   shardCount: 2,
 *   replicasPerPrimary: 2,
 *   zonalAllocationPolicy: "Automatic",
 * });
 * ```
 *
 * **Example:** Hourly RDB snapshots to a storage account
 * ```typescript
 * const cache = yield* Azure.Redis.Cache("Cache", {
 *   sku: "Premium",
 *   capacity: 1,
 *   redisConfiguration: {
 *     rdbBackupEnabled: true,
 *     rdbBackupFrequency: 60,
 *     rdbBackupMaxSnapshotCount: 1,
 *     rdbStorageConnectionString: storageConnectionString,
 *   },
 * });
 * ```
 *
 * **Example:** Replicate to another region
 * ```typescript
 * const secondary = yield* Azure.Redis.Cache("CacheWest", {
 *   location: "westus2",
 *   sku: "Premium",
 *   capacity: 1,
 * });
 * const link = yield* Azure.Redis.LinkedServer("Geo", {
 *   cache: cache.cacheName,
 *   linkedCacheId: secondary.cacheId,
 *   linkedCacheLocation: secondary.location,
 * });
 * // connect clients to link.geoReplicatedPrimaryHostName
 * ```
 *
 * ### Maintenance
 * **Example:** Patch on Sunday nights
 * ```typescript
 * yield* Azure.Redis.PatchSchedule("Patching", {
 *   cache: cache.cacheName,
 *   scheduleEntries: [{ dayOfWeek: "Sunday", startHourUtc: 2 }],
 * });
 * ```
 *
 * ### Binding to a runtime
 * Redis has no ARM data-plane binding: the runtime speaks RESP to
 * `hostName:sslPort`. Yield an Output of the cache inside the host. Alchemy
 * puts the value in the host's app settings and returns an Effect that
 * reads it at runtime. The host's identity gets no role; it signs in with
 * the access key, or with a token when you assign it an access policy.
 *
 * **Example:** Count hits with an access key from an Azure Function
 * ```typescript
 * import * as Redis from "@alchemy.run/redis";
 * import * as Redacted from "effect/Redacted";
 *
 * // init
 * const host = yield* cache.hostName;
 * const key = yield* cache.primaryKey;
 *
 * // runtime
 * const hostName = yield* host;
 * const primaryKey = yield* key;
 * const url = Redis.connectionUrl({
 *   host: hostName,
 *   port: 6380,
 *   password: Redacted.value(primaryKey!),
 *   tls: true,
 * });
 * const count = yield* Redis.run(url, "INCR", ["hits"]);
 * ```
 *
 * ### Runtime Operations
 * `FlushCache`, `ExportCacheData`, and `ImportCacheData` each assign a
 * custom role with exactly one action on this cache only, to the host's
 * managed identity or, on any other host, to an Entra service principal.
 *
 * **Example:** Flush every key
 * ```typescript
 * // init
 * const flushCache = yield* Azure.Redis.FlushCache(cache);
 *
 * // runtime
 * yield* flushCache();
 * // …provided with Effect.provide(Azure.Redis.FlushCacheHttp)
 * ```
 *
 * **Example:** Export a Premium cache to blobs and import it again
 * ```typescript
 * // init
 * const exportCacheData = yield* Azure.Redis.ExportCacheData(cache);
 * const importCacheData = yield* Azure.Redis.ImportCacheData(cache);
 *
 * // runtime
 * yield* exportCacheData({
 *   prefix: "nightly",
 *   container: "https://backups.blob.core.windows.net/redis?<sas>",
 * });
 * yield* importCacheData({
 *   files: ["https://backups.blob.core.windows.net/redis/nightly?<sas>"],
 * });
 * // …provided with Effect.provide([Azure.Redis.ExportCacheDataHttp, Azure.Redis.ImportCacheDataHttp])
 * ```
 *
 * ### Deleting a Cache
 * Destroying the cache deletes it and its data.
 *
 * **Example:** Keep the cache when the stack is destroyed
 * ```typescript
 * import * as RemovalPolicy from "alchemy/RemovalPolicy";
 *
 * const cache = yield* Azure.Redis.Cache("Cache").pipe(RemovalPolicy.retain());
 * ```
 *
 * @resource
 */
export const Cache = GroupedResource<Cache>("Azure.Redis.Cache");

type ObservedCache = redis.GetRedisResponse;
type WireConfiguration = redis.RedisCommonPropertiesRedisConfigurationInput;

const TIER_RANK: Record<string, number> = { basic: 0, standard: 1, premium: 2 };

const armLocation = (location: string) => location.replace(/\s+/g, "").toLowerCase();

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
    secondaryKey: keys?.secondaryKey ? Redacted.make(keys.secondaryKey) : undefined,
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
const num = (value: number | undefined) => (value === undefined ? undefined : String(value));

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
    preferred_data_persistence_auth_method: c.preferredDataPersistenceAuthMethod,
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
            : Object.fromEntries(identity.userAssignedIdentities.map((id) => [id, {}])),
      };

const sameIdentity = (desired: CacheIdentity | undefined, observed: ObservedCache["identity"]) => {
  const normalize = (type: string | undefined) => (type ?? "None").replace(/\s/g, "").toLowerCase();
  if (normalize(observed?.type) !== normalize(desired?.type)) return false;
  const left = (desired?.userAssignedIdentities ?? []).map((id) => id.toLowerCase()).sort();
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

const listKeys = (subscriptionId: string, resourceGroupName: string, name: string) =>
  orUndefinedIfNotFound(redis.ListRedisKeys({ subscriptionId, resourceGroupName, name }));

export const CacheProvider = () =>
  Provider.succeed(Cache, {
    stables: ["cacheName", "cacheId", "resourceGroup", "location", "hostName"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(redis.ListRedisBySubscription, { subscriptionId });
      return (page.value ?? []).flatMap((cache) => {
        const group = resourceGroupOf(cache.id);
        return hasAnyAlchemyTag(cache.tags) && group !== undefined && cache.name !== undefined
          ? [toAttrs(group, cache.name, cache, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const sku = news.sku ?? "Basic";
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && lower(news.name) !== lower(output.cacheName)) ||
        (news.location !== undefined &&
          armLocation(news.location) !== armLocation(output.location)) ||
        // Scaling down a tier is rejected; only upgrades happen in place.
        (TIER_RANK[sku.toLowerCase()] ?? 0) < (TIER_RANK[output.sku.toLowerCase()] ?? 0) ||
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
      const name = output?.cacheName ?? olds?.name ?? (yield* createCacheName(id));
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
      const name = news.name ?? output?.cacheName ?? (yield* createCacheName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const sku = toSku(news);
      const configuration = toConfiguration(news.redisConfiguration);
      const desired = {
        enableNonSslPort: news.enableNonSslPort ?? false,
        minimumTlsVersion: news.minimumTlsVersion ?? "1.2",
        publicNetworkAccess: news.publicNetworkAccess ?? "Enabled",
        updateChannel: news.updateChannel ?? "Stable",
        disableAccessKeyAuthentication: news.disableAccessKeyAuthentication ?? false,
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
      if ((props.publicNetworkAccess ?? "Enabled") !== desired.publicNetworkAccess) {
        changed.publicNetworkAccess = desired.publicNetworkAccess;
      }
      if ((props.updateChannel ?? "Stable") !== desired.updateChannel) {
        changed.updateChannel = desired.updateChannel;
      }
      if (
        (props.disableAccessKeyAuthentication ?? false) !== desired.disableAccessKeyAuthentication
      ) {
        changed.disableAccessKeyAuthentication = desired.disableAccessKeyAuthentication;
      }
      if (
        props.sku.name !== sku.name ||
        props.sku.family !== sku.family ||
        props.sku.capacity !== sku.capacity
      ) {
        changed.sku = sku;
      }
      if (news.shardCount !== undefined && props.shardCount !== news.shardCount) {
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
