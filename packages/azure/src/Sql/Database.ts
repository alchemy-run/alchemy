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
  sameId,
  skuMatches,
  type SqlSku,
} from "./common.ts";

export interface DatabaseProps {
  /**
   * Resource group of the server.
   *
   * :::caution
   * Changing it replaces the database and deletes its data.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the `Azure.Sql.Server` that holds the database.
   *
   * :::caution
   * Changing it replaces the database and deletes its data.
   * :::
   */
  server: string;
  /**
   * Database name: 1-128 characters, no `<>*%&:\/?`, not `master`.
   *
   * :::caution
   * Changing it replaces the database and deletes its data.
   * :::
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Location; it must equal the server's location.
   *
   * :::caution
   * Changing it replaces the database and deletes its data.
   * :::
   * @default the server's location
   */
  location?: string;
  /**
   * Service objective, e.g. `{ name: "Basic" }` (5 DTU), `{ name: "S0" }`
   * (10 DTU), serverless `{ name: "GP_S_Gen5_2" }`, or Hyperscale
   * `{ name: "HS_Gen5_2" }`. Scaling is an online operation; the deploy
   * waits until the new objective is active. Ignored while the database is
   * in an elastic pool.
   * @default Azure's default (`GP_Gen5_2`, provisioned vCore)
   */
  sku?: SqlSku;
  /**
   * Maximum data size in bytes. It must be a size the SKU allows, e.g.
   * `2147483648` (2 GiB) for `Basic`.
   * @default the SKU's default size
   */
  maxSizeBytes?: number;
  /**
   * ARM ID of the `Azure.Sql.ElasticPool` to place the database in. Moving
   * a database in or out of a pool happens in place.
   * @default not in a pool
   */
  elasticPoolId?: string;
  /**
   * Database collation.
   *
   * :::caution
   * Changing it replaces the database and deletes its data.
   * :::
   * @default "SQL_Latin1_General_CP1_CI_AS"
   */
  collation?: string;
  /**
   * Collation of the metadata catalog.
   *
   * :::caution
   * Changing it replaces the database and deletes its data.
   * :::
   * @default Azure's default (`SQL_Latin1_General_CP1_CI_AS`)
   */
  catalogCollation?: "DATABASE_DEFAULT" | "SQL_Latin1_General_CP1_CI_AS";
  /**
   * Sample schema loaded at creation.
   *
   * :::caution
   * Changing it replaces the database and deletes its data.
   * :::
   * @default an empty database
   */
  sampleName?: "AdventureWorksLT" | "WideWorldImportersStd" | "WideWorldImportersFull";
  /**
   * Creation mode: `Default`, `Copy`, `Secondary`, `PointInTimeRestore`,
   * `Restore`, `Recovery`, … Create-only.
   *
   * :::caution
   * Changing it replaces the database and deletes its data.
   * :::
   * @default "Default"
   */
  createMode?: string;
  /**
   * Source database ARM ID for `Copy`, `Secondary`, and restore modes.
   *
   * :::caution
   * Changing it replaces the database and deletes its data.
   * :::
   * @default none
   */
  sourceDatabaseId?: string;
  /**
   * Point in time (ISO 8601) to restore for `PointInTimeRestore`. Read only
   * at creation.
   * @default none
   */
  restorePointInTime?: string;
  /**
   * Spread replicas across availability zones (Premium, Business Critical,
   * General Purpose, and Hyperscale in supported regions).
   * @default Azure's default (`false`)
   */
  zoneRedundant?: boolean;
  /**
   * Route read-only connections (`ApplicationIntent=ReadOnly`) to a
   * secondary replica (Premium, Business Critical, and Hyperscale).
   * @default Azure's default for the SKU
   */
  readScale?: "Enabled" | "Disabled";
  /**
   * Number of high-availability secondary replicas (Business Critical,
   * Premium, and Hyperscale).
   * @default Azure's default for the SKU
   */
  highAvailabilityReplicaCount?: number;
  /**
   * Serverless auto-pause delay in minutes (minimum 15, `-1` disables
   * auto-pause).
   * @default Azure's default (`60`) on serverless SKUs
   */
  autoPauseDelay?: number;
  /**
   * Serverless minimum vCores, e.g. `0.5`.
   * @default Azure's default for the SKU
   */
  minCapacity?: number;
  /**
   * Backup storage redundancy. `Local` is the cheapest.
   * @default Azure's default (`Geo`)
   */
  requestedBackupStorageRedundancy?: "Geo" | "Local" | "Zone" | "GeoZone";
  /**
   * Make every table a ledger table.
   *
   * :::caution
   * Azure cannot change it after creation. Changing it replaces the
   * database and deletes its data.
   * :::
   * @default false
   */
  isLedgerOn?: boolean;
  /**
   * License model: `LicenseIncluded`, or `BasePrice` for Azure Hybrid
   * Benefit (vCore SKUs).
   * @default Azure's default (`LicenseIncluded`)
   */
  licenseType?: "LicenseIncluded" | "BasePrice";
  /**
   * ARM ID of a public maintenance configuration, e.g.
   * `/subscriptions/{id}/providers/Microsoft.Maintenance/publicMaintenanceConfigurations/SQL_EastUS_DB_1`.
   * @default the system default window
   */
  maintenanceConfigurationId?: string;
  /**
   * Use the subscription's free Azure SQL Database offer (serverless
   * `GP_S_Gen5_2`, a limited number per subscription).
   *
   * :::caution
   * Changing it replaces the database and deletes its data.
   * :::
   * @default false
   */
  useFreeLimit?: boolean;
  /**
   * What happens when the free monthly limit runs out: pause until next
   * month, or bill the overage.
   * @default Azure's default (`AutoPause`) with `useFreeLimit`
   */
  freeLimitExhaustionBehavior?: "AutoPause" | "BillForUsage";
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
 * A single database on an Azure SQL logical server
 * (`Microsoft.Sql/servers/databases`).
 *
 * Pick the SKU on purpose: Azure's default is a provisioned `GP_Gen5_2`
 * vCore database, billed every hour. `Basic` (5 DTU, 2 GiB) is the cheapest
 * fixed tier, serverless `GP_S_Gen5_*` pauses when idle, and `useFreeLimit`
 * uses the subscription's free serverless offer. Scaling to another SKU
 * happens online; the deploy waits until the new service objective is
 * active.
 *
 * :::caution[Changing `name`, `server`, `location`, `collation`, `createMode`, `isLedgerOn`, or `useFreeLimit` replaces the database]
 * Alchemy creates a new, empty database and deletes the old one with its
 * data. The other create-only props are `catalogCollation`, `sampleName`,
 * and `sourceDatabaseId`.
 * :::
 *
 * See [What is a single database in Azure SQL Database](https://learn.microsoft.com/azure/azure-sql/database/single-database-overview).
 *
 * ### Creating a Database
 * **Example:** Basic tier database
 * ```typescript
 * const server = yield* Azure.Sql.Server("Sql", {
 *   location: "centralus",
 *   administratorLogin: "sqladmin",
 *   administratorLoginPassword: password,
 * });
 * const db = yield* Azure.Sql.Database("Todos", {
 *   server: server.serverName,
 *   sku: { name: "Basic" },
 *   requestedBackupStorageRedundancy: "Local",
 * });
 * // db.databaseName, db.databaseId
 * ```
 *
 * **Example:** Free serverless database
 * ```typescript
 * const db = yield* Azure.Sql.Database("Todos", {
 *   server: server.serverName,
 *   sku: { name: "GP_S_Gen5_2" },
 *   useFreeLimit: true,
 *   freeLimitExhaustionBehavior: "AutoPause",
 * });
 * ```
 *
 * **Example:** Serverless database that pauses after an hour
 * ```typescript
 * const db = yield* Azure.Sql.Database("Todos", {
 *   server: server.serverName,
 *   sku: { name: "GP_S_Gen5_2" },
 *   minCapacity: 0.5,
 *   autoPauseDelay: 60,
 * });
 * ```
 *
 * **Example:** Standard tier with a size cap
 * ```typescript
 * const db = yield* Azure.Sql.Database("Todos", {
 *   server: server.serverName,
 *   sku: { name: "S0" },
 *   maxSizeBytes: 10 * 1024 * 1024 * 1024, // 10 GiB
 * });
 * ```
 *
 * ### Scaling
 * Change `sku` and deploy again. Azure scales the database online, and
 * connections drop for a few seconds at the switch.
 *
 * **Example:** Scale from Basic to S1
 * ```diff
 * const db = yield* Azure.Sql.Database("Todos", {
 *   server: server.serverName,
 * -  sku: { name: "Basic" },
 * +  sku: { name: "S1" },
 * });
 * ```
 *
 * ### Elastic Pools
 * **Example:** Database in an elastic pool
 * ```typescript
 * const pool = yield* Azure.Sql.ElasticPool("Tenants", {
 *   server: server.serverName,
 *   sku: { name: "BasicPool", capacity: 50 },
 * });
 * const db = yield* Azure.Sql.Database("TenantA", {
 *   server: server.serverName,
 *   elasticPoolId: pool.elasticPoolId,
 * });
 * ```
 *
 * ### High Availability
 * **Example:** Zone-redundant Business Critical database with read scale-out
 * ```typescript
 * const db = yield* Azure.Sql.Database("Orders", {
 *   server: server.serverName,
 *   sku: { name: "BC_Gen5_2" },
 *   zoneRedundant: true,
 *   readScale: "Enabled",
 *   requestedBackupStorageRedundancy: "Zone",
 * });
 * ```
 *
 * **Example:** Hyperscale with two high-availability replicas
 * ```typescript
 * const db = yield* Azure.Sql.Database("Orders", {
 *   server: server.serverName,
 *   sku: { name: "HS_Gen5_2" },
 *   highAvailabilityReplicaCount: 2,
 * });
 * ```
 *
 * ### Backups and Restores
 * Azure backs up every database automatically. Tune the windows with
 * `Azure.Sql.BackupShortTermRetentionPolicy` and
 * `Azure.Sql.LongTermRetentionPolicy`.
 *
 * **Example:** Keep point-in-time backups for 14 days and weekly backups for 8 weeks
 * ```typescript
 * yield* Azure.Sql.BackupShortTermRetentionPolicy("TodosPitr", {
 *   server: server.serverName,
 *   database: db.databaseName,
 *   retentionDays: 14,
 * });
 * yield* Azure.Sql.LongTermRetentionPolicy("TodosLtr", {
 *   server: server.serverName,
 *   database: db.databaseName,
 *   weeklyRetention: "P8W",
 * });
 * ```
 *
 * **Example:** Restore a point in time into a new database
 * ```typescript
 * const restored = yield* Azure.Sql.Database("TodosRestored", {
 *   server: server.serverName,
 *   createMode: "PointInTimeRestore",
 *   sourceDatabaseId: db.databaseId,
 *   restorePointInTime: "2026-10-24T12:00:00Z",
 * });
 * ```
 *
 * **Example:** Copy a database
 * ```typescript
 * const copy = yield* Azure.Sql.Database("TodosCopy", {
 *   server: server.serverName,
 *   createMode: "Copy",
 *   sourceDatabaseId: db.databaseId,
 * });
 * ```
 *
 * ### Geo-Replication
 * Put the database in an `Azure.Sql.FailoverGroup` to replicate it to a
 * server in another region behind one listener endpoint.
 *
 * **Example:** Replicate to a second region
 * ```typescript
 * const secondary = yield* Azure.Sql.Server("SqlWest", {
 *   location: "westus2",
 *   administratorLogin: "sqladmin",
 *   administratorLoginPassword: password,
 * });
 * const group = yield* Azure.Sql.FailoverGroup("Todos", {
 *   server: server.serverName,
 *   partnerServers: [secondary.serverId],
 *   databases: [db.databaseId],
 * });
 * // connect to group.readWriteListenerEndpoint
 * ```
 *
 * ### Ledger
 * **Example:** Ledger database
 * ```typescript
 * // Every table keeps a tamper-evident history. Azure cannot turn it off later.
 * const db = yield* Azure.Sql.Database("Audit", {
 *   server: server.serverName,
 *   sku: { name: "S0" },
 *   isLedgerOn: true,
 * });
 * ```
 *
 * ### Binding to a runtime
 * The runtime connects with a SQL driver. Yield `server.fullyQualifiedDomainName`
 * and `db.databaseName` inside the host to put them in its app settings,
 * then read them at runtime (see `Azure.Sql.Server` for the whole Function).
 *
 * **Example:** Read the connection values inside an Azure Function
 * ```typescript
 * // init
 * const host = yield* server.fullyQualifiedDomainName;
 * const databaseName = yield* database.databaseName;
 *
 * // runtime
 * const resolvedHost = yield* host;
 * const resolvedDatabase = yield* databaseName;
 * // MssqlClient.layer({ server: resolvedHost, database: resolvedDatabase, … })
 * ```
 *
 * ### Runtime Operations
 * Each binding assigns a custom role with exactly one action on this
 * database only, to the host's managed identity (an Azure Function, Web
 * App, Container App, container group, or VM) or to an Entra service
 * principal on any other host. Provide the matching `*Http` layer.
 *
 * **Example:** Export the database to a BACPAC file
 * ```typescript
 * // init
 * const exportDatabase = yield* Azure.Sql.ExportDatabase(db);
 *
 * // runtime
 * yield* exportDatabase({
 *   storageUri: "https://backups.blob.core.windows.net/bacpac/todos.bacpac",
 *   storageKeyType: "StorageAccessKey",
 *   storageKey: Redacted.value(storageKey),
 *   administratorLogin: "sqladmin",
 *   administratorLoginPassword: adminPassword,
 * });
 * // …provided with Effect.provide(Azure.Sql.ExportDatabaseHttp)
 * ```
 *
 * **Example:** Fail over to another replica to test retries
 * ```typescript
 * // init
 * const failoverDatabase = yield* Azure.Sql.FailoverDatabase(db);
 *
 * // runtime: Azure allows one failover every 15 minutes per database
 * yield* failoverDatabase({ replicaType: "Primary" });
 * // …provided with Effect.provide(Azure.Sql.FailoverDatabaseHttp)
 * ```
 *
 * **Example:** Pause and resume a dedicated SQL pool
 * ```typescript
 * // init: dedicated SQL pool (DataWarehouse) databases only
 * const pauseDatabase = yield* Azure.Sql.PauseDatabase(warehouse);
 * const resumeDatabase = yield* Azure.Sql.ResumeDatabase(warehouse);
 * const createRestorePoint = yield* Azure.Sql.CreateRestorePoint(warehouse);
 *
 * // runtime
 * yield* createRestorePoint({ restorePointLabel: "before-load" });
 * yield* pauseDatabase();
 * yield* resumeDatabase();
 * // …provided with Effect.provide([Azure.Sql.PauseDatabaseHttp, Azure.Sql.ResumeDatabaseHttp, Azure.Sql.CreateRestorePointHttp])
 * ```
 *
 * ### Deleting a Database
 * Destroying the database deletes it and its data. Deleting its server
 * deletes it too.
 *
 * **Example:** Keep the database when the stack is destroyed
 * ```typescript
 * import * as RemovalPolicy from "alchemy/RemovalPolicy";
 *
 * const db = yield* Azure.Sql.Database("Todos", {
 *   server: server.serverName,
 *   sku: { name: "Basic" },
 * }).pipe(RemovalPolicy.retain());
 * ```
 *
 * @resource
 */
export const Database = GroupedResource<Database>("Azure.Sql.Database");

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
const databaseState = (sku: SqlSku | undefined) => (db: sql.GetDatabaseResponse) => {
  const status = db.properties?.status;
  if (status === undefined || !READY.has(status)) return status ?? "Pending";
  const requested = db.properties?.requestedServiceObjectiveName;
  const current = db.properties?.currentServiceObjectiveName;
  if (requested !== undefined && current !== undefined && requested !== current) {
    return "Scaling";
  }
  if (sku !== undefined && !skuMatches(db.sku, sku, db.properties?.currentServiceObjectiveName)) {
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
    stables: ["databaseName", "databaseId", "serverName", "resourceGroup", "location"],

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
        (news.location !== undefined && lower(news.location) !== lower(output.location)) ||
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
      const name = output?.databaseName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getDatabase(subscriptionId, resourceGroup, serverName, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, serverName, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const { resourceGroup, server } = news;
      const name = news.name ?? output?.databaseName ?? (yield* createChildName(id));
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
      if (news.elasticPoolId !== undefined && !sameId(props.elasticPoolId, news.elasticPoolId)) {
        changed.elasticPoolId = news.elasticPoolId;
      }
      // A pooled database reports the `ElasticPool` SKU; only sync the SKU
      // when the database is meant to be standalone.
      const skuChanged =
        news.elasticPoolId === undefined &&
        news.sku !== undefined &&
        !skuMatches(observed.sku, news.sku, observed.properties?.currentServiceObjectiveName);
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
            fieldsMatch(db.properties, changed) && (!tagsChanged || !tagsDiffer(db.tags, tags)),
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
        getDatabase(subscriptionId, output.resourceGroup, output.serverName, output.databaseName),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
