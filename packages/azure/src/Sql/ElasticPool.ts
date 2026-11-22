import * as sql from "@distilled.cloud/azure/sql";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
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
import { GroupedResource } from "../StackResourceGroup.ts";
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
  /**
   * Minimum capacity (eDTUs or vCores) each database is guaranteed.
   * @default Azure's default (`0`)
   */
  minCapacity?: number;
  /**
   * Maximum capacity (eDTUs or vCores) one database may use.
   * @default Azure's default (the pool's capacity, up to the tier's limit)
   */
  maxCapacity?: number;
  /**
   * Serverless auto-pause delay in minutes (`-1` disables auto-pause).
   * @default Azure's default
   */
  autoPauseDelay?: number;
}

export interface ElasticPoolProps {
  /**
   * Resource group of the server.
   *
   * :::caution
   * Changing it replaces the pool.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the `Azure.Sql.Server` that holds the pool.
   *
   * :::caution
   * Changing it replaces the pool.
   * :::
   */
  server: string;
  /**
   * Pool name: 1-128 characters, no `<>*%&:\/?`.
   *
   * :::caution
   * Changing it replaces the pool.
   * :::
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Location; it must equal the server's location.
   *
   * :::caution
   * Changing it replaces the pool.
   * :::
   * @default the server's location
   */
  location?: string;
  /**
   * Pool SKU, e.g. `{ name: "BasicPool", capacity: 50 }` (50 eDTU),
   * `{ name: "StandardPool", capacity: 100 }`, or vCore
   * `{ name: "GP_Gen5", capacity: 2 }`. Scaling happens online.
   * @default Azure's default (`GP_Gen5`, 2 vCores)
   */
  sku?: SqlSku;
  /**
   * Maximum storage of the pool in bytes.
   * @default the SKU's default size
   */
  maxSizeBytes?: number;
  /**
   * Serverless minimum capacity of the pool, in vCores.
   * @default Azure's default for the SKU
   */
  minCapacity?: number;
  /**
   * Per-database capacity limits.
   * @default Azure's defaults
   */
  perDatabaseSettings?: ElasticPoolPerDatabaseSettings;
  /**
   * Spread replicas across availability zones.
   * @default Azure's default (`false`)
   */
  zoneRedundant?: boolean;
  /**
   * License model: `LicenseIncluded`, or `BasePrice` for Azure Hybrid
   * Benefit (vCore SKUs).
   * @default Azure's default (`LicenseIncluded`)
   */
  licenseType?: "LicenseIncluded" | "BasePrice";
  /**
   * ARM ID of a public maintenance configuration.
   * @default the system default window
   */
  maintenanceConfigurationId?: string;
  /**
   * Number of high-availability secondary replicas (Hyperscale pools).
   * @default Azure's default for the SKU
   */
  highAvailabilityReplicaCount?: number;
  /**
   * Serverless auto-pause delay in minutes.
   * @default Azure's default
   */
  autoPauseDelay?: number;
  /**
   * Secure enclave type for Always Encrypted.
   * @default Azure's default (`Default`)
   */
  preferredEnclaveType?: "Default" | "VBS";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
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
 * An Azure SQL elastic pool (`Microsoft.Sql/servers/elasticPools`): shared
 * compute and storage for many databases on one server. Databases in a
 * pool share its eDTUs or vCores, so a pool suits many small databases
 * with uneven load, such as one database per tenant.
 *
 * Alchemy deletes the pooled databases before the pool when they reference
 * its `elasticPoolId`.
 *
 * :::caution[Changing `name`, `server`, `location`, or `resourceGroup` replaces the pool]
 * Alchemy creates a new pool and deletes the old one. Point the pooled
 * databases' `elasticPoolId` at the new pool in the same deploy.
 * :::
 *
 * See [Elastic pools in Azure SQL Database](https://learn.microsoft.com/azure/azure-sql/database/elastic-pool-overview).
 *
 * ### Creating a Pool
 * **Example:** Basic 50 eDTU pool
 * ```typescript
 * const server = yield* Azure.Sql.Server("Sql", {
 *   administratorLogin: "sqladmin",
 *   administratorLoginPassword: password,
 * });
 * const pool = yield* Azure.Sql.ElasticPool("Tenants", {
 *   server: server.serverName,
 *   sku: { name: "BasicPool", capacity: 50 },
 *   perDatabaseSettings: { minCapacity: 0, maxCapacity: 5 },
 * });
 * ```
 *
 * **Example:** General Purpose vCore pool
 * ```typescript
 * const pool = yield* Azure.Sql.ElasticPool("Tenants", {
 *   server: server.serverName,
 *   sku: { name: "GP_Gen5", capacity: 4 },
 *   perDatabaseSettings: { minCapacity: 0.25, maxCapacity: 2 },
 *   licenseType: "BasePrice",
 * });
 * ```
 *
 * ### Pooling Databases
 * **Example:** Place a database in the pool
 * ```typescript
 * const tenantA = yield* Azure.Sql.Database("TenantA", {
 *   server: server.serverName,
 *   elasticPoolId: pool.elasticPoolId,
 * });
 * ```
 *
 * ### Scaling
 * Change `sku` or `perDatabaseSettings` and deploy again. Azure scales the
 * pool online; the deploy waits until the pool is ready.
 *
 * **Example:** Grow the pool to 100 eDTU
 * ```diff
 * const pool = yield* Azure.Sql.ElasticPool("Tenants", {
 *   server: server.serverName,
 * -  sku: { name: "BasicPool", capacity: 50 },
 * +  sku: { name: "StandardPool", capacity: 100 },
 * });
 * ```
 *
 * ### High Availability
 * **Example:** Zone-redundant Premium pool
 * ```typescript
 * const pool = yield* Azure.Sql.ElasticPool("Tenants", {
 *   server: server.serverName,
 *   sku: { name: "PremiumPool", capacity: 125 },
 *   zoneRedundant: true,
 * });
 * ```
 *
 * ### Runtime Operations
 * `FailoverElasticPool` fails every database of the pool over to another
 * replica in its region. The binding assigns a custom role with only
 * `Microsoft.Sql/servers/elasticPools/failover/action`, on this pool only.
 *
 * **Example:** Fail the pool over from a Function
 * ```typescript
 * // init
 * const failoverElasticPool = yield* Azure.Sql.FailoverElasticPool(pool);
 *
 * // runtime
 * yield* failoverElasticPool();
 * // …provided with Effect.provide(Azure.Sql.FailoverElasticPoolHttp)
 * ```
 *
 * @resource
 */
export const ElasticPool = GroupedResource<ElasticPool>("Azure.Sql.ElasticPool");

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
    stables: ["elasticPoolName", "elasticPoolId", "serverName", "resourceGroup", "location"],

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
        (news.location !== undefined && lower(news.location) !== lower(output.location))
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
      const name = output?.elasticPoolName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getPool(subscriptionId, resourceGroup, serverName, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, serverName, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const { resourceGroup, server } = news;
      const name = news.name ?? output?.elasticPoolName ?? (yield* createChildName(id));
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
            (sku !== undefined && !skuMatches(pool.sku, sku)) || !converged(pool)
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
      const skuChanged = news.sku !== undefined && !skuMatches(observed.sku, news.sku);
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
            fieldsMatch(pool.properties, changed) && (!tagsChanged || !tagsDiffer(pool.tags, tags)),
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
        getPool(subscriptionId, output.resourceGroup, output.serverName, output.elasticPoolName),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
