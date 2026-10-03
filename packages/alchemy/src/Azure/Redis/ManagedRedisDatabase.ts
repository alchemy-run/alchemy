import * as redisenterprise from "@distilled.cloud/azure/redisenterprise";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  clusterOwnedByStage,
  getCluster,
  getDatabase,
  lower,
  readiness,
} from "./Common.ts";

export type ManagedRedisEvictionPolicy =
  | "AllKeysLFU"
  | "AllKeysLRU"
  | "AllKeysRandom"
  | "VolatileLRU"
  | "VolatileLFU"
  | "VolatileTTL"
  | "VolatileRandom"
  | "NoEviction";

export type ManagedRedisClusteringPolicy =
  | "OSSCluster"
  | "EnterpriseCluster"
  | "NoCluster";

/** Data persistence of the database. Enable at most one of AOF or RDB. */
export interface ManagedRedisPersistence {
  /** Append-only-file persistence. */
  aofEnabled?: boolean;
  /** How often the append-only file is flushed. @default "1s" */
  aofFrequency?: "1s" | "always";
  /** Periodic snapshot (RDB) persistence. */
  rdbEnabled?: boolean;
  /** How often a snapshot is taken. */
  rdbFrequency?: "1h" | "6h" | "12h";
}

/** A Redis module enabled on the database. */
export interface ManagedRedisModule {
  /** Module name: `RedisJSON`, `RediSearch`, `RedisBloom`, or `RedisTimeSeries`. */
  name: string;
  /** Module configuration, e.g. `ERROR_RATE 0.01 INITIAL_SIZE 400`. */
  args?: string;
}

export interface ManagedRedisDatabaseProps {
  /** Resource group of the cluster. Changing it replaces the database. */
  resourceGroup: string;
  /** Name of the `Azure.Redis.ManagedRedis` cluster. Changing it replaces the database. */
  cluster: string;
  /**
   * Database name. Azure Managed Redis supports only `default`. Changing it
   * replaces the database.
   * @default "default"
   */
  name?: string;
  /**
   * Whether clients connect over TLS (`Encrypted`) or plaintext.
   * @default "Encrypted"
   */
  clientProtocol?: "Encrypted" | "Plaintext";
  /**
   * TCP port of the database endpoint. Changing it replaces the database.
   * @default 10000
   */
  port?: number;
  /**
   * Clustering policy. Changing it replaces the database (flushing its data).
   * @default "OSSCluster"
   */
  clusteringPolicy?: ManagedRedisClusteringPolicy;
  /**
   * Eviction policy once memory is full. RediSearch requires `NoEviction`.
   * @default "VolatileLRU"
   */
  evictionPolicy?: ManagedRedisEvictionPolicy;
  /** Data persistence. Omit to disable persistence. */
  persistence?: ManagedRedisPersistence;
  /** Redis modules. Modules can only be set at creation; changing them replaces the database. */
  modules?: ManagedRedisModule[];
  /**
   * Defer Redis version upgrades.
   * @default "NotDeferred"
   */
  deferUpgrade?: "Deferred" | "NotDeferred";
  /**
   * Allow clients to authenticate with the database access keys. When
   * disabled only Microsoft Entra ID (see
   * `Azure.Redis.AccessPolicyAssignment`) is accepted.
   * @default "Disabled"
   */
  accessKeysAuthentication?: "Enabled" | "Disabled";
}

export interface ManagedRedisDatabase extends Resource<
  "Azure.Redis.ManagedRedisDatabase",
  ManagedRedisDatabaseProps,
  {
    /** Name of the database. */
    databaseName: string;
    /** ARM resource ID of the database. */
    databaseId: string;
    /** Name of the cluster that holds the database. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** DNS name of the endpoint (the cluster host name). */
    hostName: string;
    /** TCP port of the endpoint. */
    port: number;
    /** Redis version of the database. */
    redisVersion: string | undefined;
    /** Data-plane state of the database, e.g. `Running`. */
    resourceState: string | undefined;
    /** Client protocol (`Encrypted` or `Plaintext`). */
    clientProtocol: string | undefined;
    /** Clustering policy. */
    clusteringPolicy: string | undefined;
    /** Eviction policy. */
    evictionPolicy: string | undefined;
    /** Whether access-key authentication is enabled. */
    accessKeysAuthentication: string | undefined;
    /** Primary access key; only set when `accessKeysAuthentication` is `Enabled`. */
    primaryKey: Redacted.Redacted<string> | undefined;
    /** Secondary access key; only set when `accessKeysAuthentication` is `Enabled`. */
    secondaryKey: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
> {}

/**
 * The Redis database of an Azure Managed Redis cluster. Each cluster holds
 * exactly one database, named `default`.
 *
 * Databases have no tags; they belong to the stage that owns their cluster.
 *
 * @see https://learn.microsoft.com/azure/redis/overview
 *
 * ### Creating a Database
 * **Example:** Database with Entra ID authentication only
 * ```typescript
 * const redis = yield* Azure.Redis.ManagedRedis("cache", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const db = yield* Azure.Redis.ManagedRedisDatabase("db", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: redis.clusterName,
 * });
 * ```
 *
 * **Example:** Cache with access keys and LRU eviction
 * ```typescript
 * const db = yield* Azure.Redis.ManagedRedisDatabase("db", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: redis.clusterName,
 *   evictionPolicy: "AllKeysLRU",
 *   accessKeysAuthentication: "Enabled",
 * });
 * // db.hostName, db.port, db.primaryKey
 * ```
 *
 * ### Modules and Persistence
 * **Example:** JSON and search with snapshot persistence
 * ```typescript
 * const db = yield* Azure.Redis.ManagedRedisDatabase("db", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: redis.clusterName,
 *   clusteringPolicy: "EnterpriseCluster",
 *   evictionPolicy: "NoEviction",
 *   modules: [{ name: "RedisJSON" }, { name: "RediSearch" }],
 *   persistence: { rdbEnabled: true, rdbFrequency: "6h" },
 * });
 * ```
 *
 * @resource
 */
export const ManagedRedisDatabase = Resource<ManagedRedisDatabase>(
  "Azure.Redis.ManagedRedisDatabase",
);

type ObservedDatabase = redisenterprise.GetDatabaseResponse;

const redact = (value: string | undefined) =>
  value === undefined ? undefined : Redacted.make(value);

const listKeys = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  databaseName: string,
) =>
  redisenterprise
    .ListDatabaseKeys({
      subscriptionId,
      resourceGroupName,
      clusterName,
      databaseName,
    })
    .pipe(
      Effect.map((keys) => ({
        primaryKey: redact(keys.primaryKey),
        secondaryKey: redact(keys.secondaryKey),
      })),
    );

const toAttrs = Effect.fn(function* (
  subscriptionId: string,
  resourceGroup: string,
  cluster: string,
  name: string,
  database: ObservedDatabase,
) {
  const props = database.properties;
  const observedCluster = yield* getCluster(
    subscriptionId,
    resourceGroup,
    cluster,
  );
  const keys =
    props?.accessKeysAuthentication === "Enabled"
      ? yield* listKeys(subscriptionId, resourceGroup, cluster, name)
      : { primaryKey: undefined, secondaryKey: undefined };
  return {
    databaseName: name,
    databaseId: database.id ?? "",
    cluster,
    resourceGroup,
    hostName: observedCluster?.properties?.hostName ?? "",
    port: props?.port ?? 10000,
    redisVersion: props?.redisVersion,
    resourceState: props?.resourceState,
    clientProtocol: props?.clientProtocol,
    clusteringPolicy: props?.clusteringPolicy,
    evictionPolicy: props?.evictionPolicy,
    accessKeysAuthentication: props?.accessKeysAuthentication,
    ...keys,
  } satisfies ManagedRedisDatabase["Attributes"];
});

const moduleKey = (modules: ReadonlyArray<{ name: string; args?: string }>) =>
  modules
    .map((m) => `${m.name.toLowerCase()}:${m.args ?? ""}`)
    .sort()
    .join(",");

/** Persistence as Azure reports it (disabled flags omitted or `false`). */
const samePersistence = (
  desired: ManagedRedisPersistence | undefined,
  observed: redisenterprise.Persistence | undefined,
) =>
  (desired?.aofEnabled ?? false) === (observed?.aofEnabled ?? false) &&
  (desired?.rdbEnabled ?? false) === (observed?.rdbEnabled ?? false) &&
  (desired?.aofEnabled !== true ||
    (desired.aofFrequency ?? "1s") === observed?.aofFrequency) &&
  (desired?.rdbEnabled !== true ||
    desired.rdbFrequency === undefined ||
    desired.rdbFrequency === observed?.rdbFrequency);

const PROVISION_BUDGET = { interval: "10 seconds", times: 60 } as const;

export const ManagedRedisDatabaseProvider = () =>
  Provider.succeed(ManagedRedisDatabase, {
    stables: ["databaseName", "databaseId", "cluster", "resourceGroup"],

    // Databases live inside a cluster; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.cluster) !== lower(output.cluster) ||
        lower(news.name ?? "default") !== lower(output.databaseName) ||
        (news.port !== undefined && news.port !== output.port) ||
        (news.clusteringPolicy ?? "OSSCluster") !==
          (output.clusteringPolicy ?? "OSSCluster") ||
        (olds !== undefined &&
          moduleKey(news.modules ?? []) !== moduleKey(olds.modules ?? []))
      ) {
        // A cluster holds one database named `default`; the old one must go
        // before its replacement is created.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cluster = output?.cluster ?? olds?.cluster;
      if (resourceGroup === undefined || cluster === undefined) {
        return undefined;
      }
      const name = output?.databaseName ?? olds?.name ?? "default";
      const observed = yield* getDatabase(
        subscriptionId,
        resourceGroup,
        cluster,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = yield* toAttrs(
        subscriptionId,
        resourceGroup,
        cluster,
        name,
        observed,
      );
      return (yield* clusterOwnedByStage(
        subscriptionId,
        resourceGroup,
        cluster,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Cache");
      const { resourceGroup, cluster } = news;
      const name = news.name ?? output?.databaseName ?? "default";
      const desired = {
        clientProtocol: news.clientProtocol ?? "Encrypted",
        evictionPolicy: news.evictionPolicy ?? "VolatileLRU",
        deferUpgrade: news.deferUpgrade ?? "NotDeferred",
        accessKeysAuthentication: news.accessKeysAuthentication ?? "Disabled",
      };
      const persistence = {
        aofEnabled: news.persistence?.aofEnabled ?? false,
        rdbEnabled: news.persistence?.rdbEnabled ?? false,
        aofFrequency: news.persistence?.aofEnabled
          ? (news.persistence.aofFrequency ?? "1s")
          : undefined,
        rdbFrequency: news.persistence?.rdbEnabled
          ? news.persistence.rdbFrequency
          : undefined,
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: cluster,
        databaseName: name,
      };
      const label = `managed redis database ${cluster}/${name}`;
      const get = getDatabase(subscriptionId, resourceGroup, cluster, name);

      // Observe.
      let observed = yield* get;

      // Ensure. Port, clustering policy and modules are create-only.
      if (observed === undefined) {
        yield* redisenterprise.CreateDatabase({
          ...where,
          properties: {
            ...desired,
            port: news.port ?? 10000,
            clusteringPolicy: news.clusteringPolicy ?? "OSSCluster",
            modules: news.modules,
            persistence: news.persistence ? persistence : undefined,
          },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        readiness,
        PROVISION_BUDGET,
      );

      // Sync mutable settings against observed state. Databases reject
      // PATCH, so a delta is applied with a full PUT that keeps the
      // observed create-only settings.
      const props = observed.properties;
      const drifted =
        (Object.keys(desired) as (keyof typeof desired)[]).some(
          (key) => props?.[key] !== desired[key],
        ) || !samePersistence(news.persistence, props?.persistence);
      if (drifted) {
        yield* redisenterprise.CreateDatabase({
          ...where,
          properties: {
            ...desired,
            port: props?.port,
            clusteringPolicy: props?.clusteringPolicy,
            modules: props?.modules?.map((m) => ({
              name: m.name,
              args: m.args,
            })),
            persistence:
              news.persistence ||
              props?.persistence?.aofEnabled ||
              props?.persistence?.rdbEnabled
                ? persistence
                : undefined,
          },
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          readiness,
          PROVISION_BUDGET,
        );
      }

      return yield* toAttrs(
        subscriptionId,
        resourceGroup,
        cluster,
        name,
        observed,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        redisenterprise.DeleteDatabase({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          clusterName: output.cluster,
          databaseName: output.databaseName,
        }),
      );
      yield* waitUntilGone(
        `managed redis database ${output.cluster}/${output.databaseName}`,
        getDatabase(
          subscriptionId,
          output.resourceGroup,
          output.cluster,
          output.databaseName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Redis.ManagedRedis", "Azure.Resources.ResourceGroup"],
    },
  });
