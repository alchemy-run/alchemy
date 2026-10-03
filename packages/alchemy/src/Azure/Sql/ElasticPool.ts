import * as sql from "@distilled.cloud/azure/sql";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  childLocation,
  createChildName,
  fieldsMatch,
  lower,
  readyState,
  skuMatches,
  type SqlSku,
} from "./common.ts";

/** Per-database limits inside an elastic pool. */
export interface ElasticPoolPerDatabaseSettings {
  /** Minimum capacity (eDTUs or vCores) each database is guaranteed. */
  minCapacity?: number;
  /** Maximum capacity (eDTUs or vCores) one database may use. */
  maxCapacity?: number;
  /** Serverless auto-pause delay in minutes (`-1` disables auto-pause). */
  autoPauseDelay?: number;
}

export interface ElasticPoolProps {
  /** Resource group of the server. Changing it replaces the pool. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the pool. */
  server: string;
  /**
   * Pool name (1-128 characters, no `<>*%&:\/?`). If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the pool.
   */
  name?: string;
  /**
   * Location; must equal the server's location. Changing it replaces the
   * pool.
   * @default the server's location
   */
  location?: string;
  /**
   * Pool SKU, e.g. `{ name: "BasicPool", capacity: 50 }`,
   * `{ name: "StandardPool", capacity: 50 }`, or `{ name: "GP_Gen5", capacity: 2 }`.
   * @default Azure's default (`GP_Gen5`, 2 vCores)
   */
  sku?: SqlSku;
  /** Maximum storage of the pool in bytes. */
  maxSizeBytes?: number;
  /** Serverless minimum capacity of the pool. */
  minCapacity?: number;
  /** Per-database capacity limits. */
  perDatabaseSettings?: ElasticPoolPerDatabaseSettings;
  /** Spread replicas across availability zones. */
  zoneRedundant?: boolean;
  /** License model (`LicenseIncluded` or Azure Hybrid Benefit `BasePrice`). */
  licenseType?: "LicenseIncluded" | "BasePrice";
  /** Maintenance configuration ARM ID. */
  maintenanceConfigurationId?: string;
  /** Number of high-availability secondary replicas (Hyperscale). */
  highAvailabilityReplicaCount?: number;
  /** Serverless auto-pause delay in minutes. */
  autoPauseDelay?: number;
  /** Secure enclave type. */
  preferredEnclaveType?: "Default" | "VBS";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ElasticPool extends Resource<
  "Azure.Sql.ElasticPool",
  ElasticPoolProps,
  {
    /** Name of the pool. */
    elasticPoolName: string;
    /** ARM resource ID of the pool; pass it as a database's `elasticPoolId`. */
    elasticPoolId: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Location of the pool. */
    location: string;
    /** Pool state, e.g. `Ready`. */
    state: string | undefined;
    /** Current SKU name. */
    skuName: string | undefined;
    /** Current SKU capacity. */
    skuCapacity: number | undefined;
    /** Maximum storage in bytes. */
    maxSizeBytes: number | undefined;
    /** Per-database capacity limits. */
    perDatabaseSettings: ElasticPoolPerDatabaseSettings | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure SQL elastic pool — shared compute and storage for many
 * databases on one server.
 *
 * Delete the pooled databases before the pool; Alchemy does this
 * automatically when databases reference the pool's `elasticPoolId`.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/elastic-pool-overview
 *
 * ### Creating a Pool
 * **Example:** Basic 50 eDTU pool
 * ```typescript
 * const pool = yield* Azure.Sql.ElasticPool("pool", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   sku: { name: "BasicPool", capacity: 50 },
 *   perDatabaseSettings: { minCapacity: 0, maxCapacity: 5 },
 * });
 * ```
 *
 * ### Pooling Databases
 * **Example:** Place a database in the pool
 * ```typescript
 * yield* Azure.Sql.Database("tenant-a", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   elasticPoolId: pool.elasticPoolId,
 * });
 * ```
 *
 * @resource
 */
export const ElasticPool = Resource<ElasticPool>("Azure.Sql.ElasticPool");

const getPool = (
  subscriptionId: string,
  resourceGroupName: string,
  serverName: string,
  elasticPoolName: string,
) =>
  orUndefinedIfNotFound(
    sql.GetElasticPool({
      subscriptionId,
      resourceGroupName,
      serverName,
      elasticPoolName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  serverName: string,
  name: string,
  pool: sql.GetElasticPoolResponse,
): ElasticPool["Attributes"] => ({
  elasticPoolName: name,
  elasticPoolId: pool.id ?? "",
  serverName,
  resourceGroup,
  location: pool.location,
  state: pool.properties?.state,
  skuName: pool.sku?.name,
  skuCapacity: pool.sku?.capacity,
  maxSizeBytes: pool.properties?.maxSizeBytes,
  perDatabaseSettings: pool.properties?.perDatabaseSettings,
  tags: userTags(pool.tags),
});

const perDatabaseDiffers = (
  observed: ElasticPoolPerDatabaseSettings | undefined,
  desired: ElasticPoolPerDatabaseSettings,
) =>
  (Object.keys(desired) as (keyof ElasticPoolPerDatabaseSettings)[]).some(
    (key) => desired[key] !== undefined && observed?.[key] !== desired[key],
  );

export const ElasticPoolProvider = () =>
  Provider.succeed(ElasticPool, {
    stables: [
      "elasticPoolName",
      "elasticPoolId",
      "serverName",
      "resourceGroup",
      "location",
    ],

    // Pools live inside a server; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.server) !== lower(output.serverName) ||
        (news.name !== undefined && news.name !== output.elasticPoolName) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.serverName ?? olds?.server;
      if (resourceGroup === undefined || serverName === undefined) {
        return undefined;
      }
      const name =
        output?.elasticPoolName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getPool(
        subscriptionId,
        resourceGroup,
        serverName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, serverName, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const { resourceGroup, server } = news;
      const name =
        news.name ?? output?.elasticPoolName ?? (yield* createChildName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        serverName: server,
        elasticPoolName: name,
      };
      const get = getPool(subscriptionId, resourceGroup, server, name);
      const waitReady = (
        sku?: SqlSku,
        converged: (pool: sql.GetElasticPoolResponse) => boolean = () => true,
      ) =>
        waitForProvisioned(
          `sql elastic pool ${name}`,
          get,
          (pool) =>
            (sku !== undefined && !skuMatches(pool.sku, sku)) ||
            !converged(pool)
              ? "Updating"
              : readyState(pool.properties?.state),
          { interval: "5 seconds", times: 120 },
        );
      const mutable = {
        maxSizeBytes: news.maxSizeBytes,
        minCapacity: news.minCapacity,
        zoneRedundant: news.zoneRedundant,
        licenseType: news.licenseType,
        maintenanceConfigurationId: news.maintenanceConfigurationId,
        highAvailabilityReplicaCount: news.highAvailabilityReplicaCount,
        autoPauseDelay: news.autoPauseDelay,
        preferredEnclaveType: news.preferredEnclaveType,
      };

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        const location = yield* childLocation(
          subscriptionId,
          resourceGroup,
          server,
          news.location ?? output?.location,
          env.location,
        );
        yield* sql.ElasticPoolsCreateOrUpdate({
          ...where,
          location,
          tags,
          sku: news.sku,
          properties: {
            ...mutable,
            perDatabaseSettings: news.perDatabaseSettings,
          },
        });
      }
      observed = yield* waitReady();

      // Sync mutable aspects against the observed pool.
      const props = observed.properties ?? {};
      const changed: sql.ElasticPoolUpdateProperties = {};
      for (const key of Object.keys(mutable) as (keyof typeof mutable)[]) {
        const value = mutable[key];
        if (value !== undefined && props[key] !== value) {
          Object.assign(changed, { [key]: value });
        }
      }
      if (
        news.perDatabaseSettings !== undefined &&
        perDatabaseDiffers(props.perDatabaseSettings, news.perDatabaseSettings)
      ) {
        changed.perDatabaseSettings = news.perDatabaseSettings;
      }
      const skuChanged =
        news.sku !== undefined && !skuMatches(observed.sku, news.sku);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(changed).length > 0 || skuChanged || tagsChanged) {
        yield* sql.UpdateElasticPool({
          ...where,
          sku: skuChanged ? news.sku : undefined,
          tags: tagsChanged ? tags : undefined,
          properties: Object.keys(changed).length > 0 ? changed : undefined,
        });
        observed = yield* waitReady(
          skuChanged ? news.sku : undefined,
          (pool) =>
            fieldsMatch(pool.properties, changed) &&
            (!tagsChanged || !tagsDiffer(pool.tags, tags)),
        );
      }

      return toAttrs(resourceGroup, server, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sql.DeleteElasticPool({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serverName: output.serverName,
          elasticPoolName: output.elasticPoolName,
        }),
      );
      yield* waitUntilGone(
        `sql elastic pool ${output.elasticPoolName}`,
        getPool(
          subscriptionId,
          output.resourceGroup,
          output.serverName,
          output.elasticPoolName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
