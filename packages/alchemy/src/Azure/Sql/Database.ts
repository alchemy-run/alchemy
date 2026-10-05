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
  sameId,
  skuMatches,
  type SqlSku,
} from "./common.ts";

export interface DatabaseProps {
  /** Resource group of the server. Changing it replaces the database. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the database. */
  server: string;
  /**
   * Database name (1-128 characters, no `<>*%&:\/?`, not `master`). If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the database.
   */
  name?: string;
  /**
   * Location; must equal the server's location. Changing it replaces the
   * database.
   * @default the server's location
   */
  location?: string;
  /**
   * Service objective, e.g. `{ name: "Basic" }`, `{ name: "S0" }`, or
   * serverless `{ name: "GP_S_Gen5_2" }`. Scaling is an online operation.
   * Ignored while the database is in an elastic pool.
   * @default Azure's default (`GP_Gen5_2`, provisioned vCore)
   */
  sku?: SqlSku;
  /** Maximum data size in bytes (must be a size the SKU allows). */
  maxSizeBytes?: number;
  /** ARM ID of the elastic pool to place the database in. */
  elasticPoolId?: string;
  /**
   * Database collation. Changing it replaces the database.
   * @default "SQL_Latin1_General_CP1_CI_AS"
   */
  collation?: string;
  /**
   * Collation of the metadata catalog. Changing it replaces the database.
   */
  catalogCollation?: "DATABASE_DEFAULT" | "SQL_Latin1_General_CP1_CI_AS";
  /**
   * Sample schema loaded at creation. Changing it replaces the database.
   */
  sampleName?:
    | "AdventureWorksLT"
    | "WideWorldImportersStd"
    | "WideWorldImportersFull";
  /**
   * Creation mode (`Default`, `Copy`, `Secondary`, `PointInTimeRestore`,
   * …). Create-only: changing it replaces the database.
   * @default "Default"
   */
  createMode?: string;
  /**
   * Source database ARM ID for `Copy`, `Secondary`, and restore modes.
   * Changing it replaces the database.
   */
  sourceDatabaseId?: string;
  /** Point in time (ISO 8601) to restore for `PointInTimeRestore`. */
  restorePointInTime?: string;
  /** Spread replicas across availability zones. */
  zoneRedundant?: boolean;
  /** Read-only routing to a secondary replica (Premium/Business Critical/Hyperscale). */
  readScale?: "Enabled" | "Disabled";
  /** Number of high-availability secondary replicas. */
  highAvailabilityReplicaCount?: number;
  /** Serverless auto-pause delay in minutes (`-1` disables auto-pause). */
  autoPauseDelay?: number;
  /** Serverless minimum vCores. */
  minCapacity?: number;
  /** Backup storage redundancy. */
  requestedBackupStorageRedundancy?: "Geo" | "Local" | "Zone" | "GeoZone";
  /**
   * Make every table a ledger table. Cannot be changed after creation, so
   * changing it replaces the database.
   * @default false
   */
  isLedgerOn?: boolean;
  /** License model (`LicenseIncluded` or Azure Hybrid Benefit `BasePrice`). */
  licenseType?: "LicenseIncluded" | "BasePrice";
  /** Maintenance configuration ARM ID. */
  maintenanceConfigurationId?: string;
  /**
   * Use the subscription's free Azure SQL Database offer (serverless
   * `GP_S_Gen5_2`, limited per subscription). Changing it replaces the
   * database.
   */
  useFreeLimit?: boolean;
  /** What happens when the free monthly limit is exhausted. */
  freeLimitExhaustionBehavior?: "AutoPause" | "BillForUsage";
  /** Secure enclave type. */
  preferredEnclaveType?: "Default" | "VBS";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Database extends Resource<
  "Azure.Sql.Database",
  DatabaseProps,
  {
    /** Name of the database. */
    databaseName: string;
    /** ARM resource ID of the database. */
    databaseId: string;
    /** Database GUID (`properties.databaseId`). */
    databaseGuid: string | undefined;
    /** Name of the SQL server. */
    serverName: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Location of the database. */
    location: string;
    /** Database status, e.g. `Online`. */
    status: string | undefined;
    /** Current SKU name. */
    skuName: string | undefined;
    /** Current SKU tier. */
    skuTier: string | undefined;
    /** Current SKU capacity. */
    skuCapacity: number | undefined;
    /** Current service objective, e.g. `Basic`, `S0`. */
    currentServiceObjectiveName: string | undefined;
    /** Maximum data size in bytes. */
    maxSizeBytes: number | undefined;
    /** Elastic pool holding the database, if any. */
    elasticPoolId: string | undefined;
    /** Database collation. */
    collation: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A single database on an Azure SQL logical server.
 *
 * Choose the SKU deliberately: Azure's default is a provisioned
 * `GP_Gen5_2` vCore database. `Basic` (5 DTU) is the cheapest fixed tier
 * and `useFreeLimit` uses the free serverless offer.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/single-database-overview
 *
 * ### Creating a Database
 * **Example:** Basic tier database
 * ```typescript
 * const db = yield* Azure.Sql.Database("app", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   sku: { name: "Basic" },
 * });
 * ```
 *
 * **Example:** Free serverless database
 * ```typescript
 * const db = yield* Azure.Sql.Database("app", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   sku: { name: "GP_S_Gen5_2" },
 *   useFreeLimit: true,
 *   freeLimitExhaustionBehavior: "AutoPause",
 * });
 * ```
 *
 * ### Elastic Pools
 * **Example:** Database in an elastic pool
 * ```typescript
 * const pool = yield* Azure.Sql.ElasticPool("pool", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   sku: { name: "BasicPool", capacity: 50 },
 * });
 * const db = yield* Azure.Sql.Database("tenant-a", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   elasticPoolId: pool.elasticPoolId,
 * });
 * ```
 *
 * @resource
 */
export const Database = Resource<Database>("Azure.Sql.Database");

const getDatabase = (
  subscriptionId: string,
  resourceGroupName: string,
  serverName: string,
  databaseName: string,
) =>
  orUndefinedIfNotFound(
    sql.GetDatabase({
      subscriptionId,
      resourceGroupName,
      serverName,
      databaseName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  serverName: string,
  name: string,
  db: sql.GetDatabaseResponse,
): Database["Attributes"] => ({
  databaseName: name,
  databaseId: db.id ?? "",
  databaseGuid: db.properties?.databaseId,
  serverName,
  resourceGroup,
  location: db.location,
  status: db.properties?.status,
  skuName: db.sku?.name,
  skuTier: db.sku?.tier,
  skuCapacity: db.sku?.capacity,
  currentServiceObjectiveName: db.properties?.currentServiceObjectiveName,
  maxSizeBytes: db.properties?.maxSizeBytes,
  elasticPoolId: db.properties?.elasticPoolId,
  collation: db.properties?.collation,
  tags: userTags(db.tags),
});

const READY = new Set(["Online", "Paused", "AutoClosed"]);

/**
 * Ready once the database is online and any requested scale has landed
 * (`currentServiceObjectiveName` catches up with the requested one).
 */
const databaseState =
  (sku: SqlSku | undefined) => (db: sql.GetDatabaseResponse) => {
    const status = db.properties?.status;
    if (status === undefined || !READY.has(status)) return status ?? "Pending";
    const requested = db.properties?.requestedServiceObjectiveName;
    const current = db.properties?.currentServiceObjectiveName;
    if (
      requested !== undefined &&
      current !== undefined &&
      requested !== current
    ) {
      return "Scaling";
    }
    if (
      sku !== undefined &&
      !skuMatches(db.sku, sku, db.properties?.currentServiceObjectiveName)
    ) {
      return "Scaling";
    }
    return "Succeeded";
  };

/** Create-only properties: changing any of them replaces the database. */
const CREATE_ONLY = [
  "collation",
  "catalogCollation",
  "sampleName",
  "createMode",
  "sourceDatabaseId",
  "isLedgerOn",
  "useFreeLimit",
] as const;

export const DatabaseProvider = () =>
  Provider.succeed(Database, {
    stables: [
      "databaseName",
      "databaseId",
      "serverName",
      "resourceGroup",
      "location",
    ],

    // Databases live inside a server; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.server) !== lower(output.serverName) ||
        (news.name !== undefined && news.name !== output.databaseName) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        CREATE_ONLY.some((key) => olds !== undefined && news[key] !== olds[key])
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
        output?.databaseName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getDatabase(
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
        news.name ?? output?.databaseName ?? (yield* createChildName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        serverName: server,
        databaseName: name,
      };
      const get = getDatabase(subscriptionId, resourceGroup, server, name);
      const waitReady = (
        sku?: SqlSku,
        converged: (db: sql.GetDatabaseResponse) => boolean = () => true,
      ) =>
        waitForProvisioned(
          `sql database ${name}`,
          get,
          (db) => (converged(db) ? databaseState(sku)(db) : "Updating"),
          { interval: "5 seconds", times: 120 },
        );
      const mutable = {
        maxSizeBytes: news.maxSizeBytes,
        zoneRedundant: news.zoneRedundant,
        readScale: news.readScale,
        highAvailabilityReplicaCount: news.highAvailabilityReplicaCount,
        autoPauseDelay: news.autoPauseDelay,
        minCapacity: news.minCapacity,
        requestedBackupStorageRedundancy: news.requestedBackupStorageRedundancy,
        licenseType: news.licenseType,
        maintenanceConfigurationId: news.maintenanceConfigurationId,
        freeLimitExhaustionBehavior: news.freeLimitExhaustionBehavior,
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
        yield* sql.DatabasesCreateOrUpdate({
          ...where,
          location,
          tags,
          sku: news.elasticPoolId === undefined ? news.sku : undefined,
          properties: {
            ...mutable,
            elasticPoolId: news.elasticPoolId,
            collation: news.collation,
            catalogCollation: news.catalogCollation,
            sampleName: news.sampleName,
            createMode: news.createMode,
            sourceDatabaseId: news.sourceDatabaseId,
            restorePointInTime: news.restorePointInTime,
            isLedgerOn: news.isLedgerOn,
            useFreeLimit: news.useFreeLimit,
          },
        });
      }
      observed = yield* waitReady();

      // Sync mutable aspects against the observed database.
      const props = observed.properties ?? {};
      const changed: sql.DatabaseUpdatePropertiesInput = {};
      for (const key of Object.keys(mutable) as (keyof typeof mutable)[]) {
        const value = mutable[key];
        if (value !== undefined && props[key] !== value) {
          Object.assign(changed, { [key]: value });
        }
      }
      if (
        news.elasticPoolId !== undefined &&
        !sameId(props.elasticPoolId, news.elasticPoolId)
      ) {
        changed.elasticPoolId = news.elasticPoolId;
      }
      // A pooled database reports the `ElasticPool` SKU; only sync the SKU
      // when the database is meant to be standalone.
      const skuChanged =
        news.elasticPoolId === undefined &&
        news.sku !== undefined &&
        !skuMatches(
          observed.sku,
          news.sku,
          observed.properties?.currentServiceObjectiveName,
        );
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(changed).length > 0 || skuChanged || tagsChanged) {
        yield* sql.UpdateDatabase({
          ...where,
          sku: skuChanged ? news.sku : undefined,
          tags: tagsChanged ? tags : undefined,
          properties: Object.keys(changed).length > 0 ? changed : undefined,
        });
        observed = yield* waitReady(
          skuChanged ? news.sku : undefined,
          (db) =>
            fieldsMatch(db.properties, changed) &&
            (!tagsChanged || !tagsDiffer(db.tags, tags)),
        );
      }

      return toAttrs(resourceGroup, server, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sql.DeleteDatabase({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serverName: output.serverName,
          databaseName: output.databaseName,
        }),
      );
      yield* waitUntilGone(
        `sql database ${output.databaseName}`,
        getDatabase(
          subscriptionId,
          output.resourceGroup,
          output.serverName,
          output.databaseName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
