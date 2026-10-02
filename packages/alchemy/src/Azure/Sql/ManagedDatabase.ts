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
import { createChildName, lower } from "./common.ts";
import { instancePath, type InstanceScope } from "./setting.ts";

export interface ManagedDatabaseProps {
  /** Resource group of the managed instance. Changing it replaces the database. */
  resourceGroup: string;
  /** Name of the SQL managed instance. Changing it replaces the database. */
  managedInstance: string;
  /**
   * Database name (1-128 characters). If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces
   * the database.
   */
  name?: string;
  /**
   * Location; must equal the managed instance's location.
   * @default the managed instance's location
   */
  location?: string;
  /**
   * Collation of the database. Changing it replaces the database.
   * @default "SQL_Latin1_General_CP1_CI_AS"
   */
  collation?: string;
  /**
   * Collation of the metadata catalog. Changing it replaces the database.
   * @default "DATABASE_DEFAULT"
   */
  catalogCollation?: "DATABASE_DEFAULT" | "SQL_Latin1_General_CP1_CI_AS";
  /**
   * Make every table a ledger table. Cannot be changed after creation,
   * so changing it replaces the database.
   * @default false
   */
  isLedgerOn?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ManagedDatabase extends Resource<
  "Azure.Sql.ManagedDatabase",
  ManagedDatabaseProps,
  {
    /** Name of the database. */
    databaseName: string;
    /** ARM resource ID of the database. */
    databaseId: string;
    /** Resource group of the managed instance. */
    resourceGroup: string;
    /** Name of the SQL managed instance. */
    managedInstanceName: string;
    /** Location of the database. */
    location: string;
    /** Database status, e.g. `Online`. */
    status: string | undefined;
    /** Collation of the database. */
    collation: string | undefined;
    /** Whether every table is a ledger table. */
    isLedgerOn: boolean | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A database on an Azure SQL Managed Instance. The database has no
 * compute or storage charge of its own; it uses the instance's vCores
 * and storage.
 *
 * Point-in-time restores, cross-instance restores, and Log Replay
 * Service migrations are not modelled; this resource creates empty
 * databases.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/managed-instance/sql-managed-instance-paas-overview
 *
 * ### Creating a Database
 * **Example:** Empty database on a managed instance
 * ```typescript
 * const database = yield* Azure.Sql.ManagedDatabase("orders", {
 *   resourceGroup: group.resourceGroupName,
 *   managedInstance: instance.managedInstanceName,
 * });
 * ```
 *
 * **Example:** Ledger database with tags
 * ```typescript
 * yield* Azure.Sql.ManagedDatabase("audit", {
 *   resourceGroup: group.resourceGroupName,
 *   managedInstance: instance.managedInstanceName,
 *   isLedgerOn: true,
 *   tags: { team: "compliance" },
 * });
 * ```
 *
 * @resource
 */
export const ManagedDatabase = Resource<ManagedDatabase>(
  "Azure.Sql.ManagedDatabase",
);

type Observed = sql.GetManagedDatabaseResponse;

const getDatabase = (
  subscriptionId: string,
  scope: InstanceScope,
  databaseName: string,
) =>
  orUndefinedIfNotFound(
    sql.GetManagedDatabase({
      ...instancePath(subscriptionId, scope),
      databaseName,
    }),
  );

const toAttrs = (
  scope: InstanceScope,
  name: string,
  db: Observed,
): ManagedDatabase["Attributes"] => ({
  databaseName: name,
  databaseId: db.id ?? "",
  resourceGroup: scope.resourceGroup,
  managedInstanceName: scope.managedInstanceName,
  location: db.location ?? "",
  status: db.properties?.status,
  collation: db.properties?.collation,
  isLedgerOn: db.properties?.isLedgerOn,
  tags: userTags(db.tags),
});

/** Map the database status (`Online`) to ARM's `Succeeded`. */
const statusOf = (db: Observed) => {
  const status = db.properties?.status;
  if (status === "Online") return "Succeeded";
  if (status === "Inaccessible" || status === "Offline") return "Failed";
  return status ?? "Creating";
};

export const ManagedDatabaseProvider = () =>
  Provider.succeed(ManagedDatabase, {
    stables: [
      "databaseName",
      "databaseId",
      "resourceGroup",
      "managedInstanceName",
      "location",
    ],

    // Databases are removed with their managed instance.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.managedInstance) !== lower(output.managedInstanceName) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.databaseName)) ||
        (news.location !== undefined &&
          lower(news.location)?.replace(/\s/g, "") !==
            lower(output.location)?.replace(/\s/g, "")) ||
        (news.collation !== undefined &&
          lower(news.collation) !== lower(output.collation)) ||
        (news.isLedgerOn ?? false) !== (output.isLedgerOn ?? false)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const managedInstanceName =
        output?.managedInstanceName ?? olds?.managedInstance;
      if (resourceGroup === undefined || managedInstanceName === undefined) {
        return undefined;
      }
      const scope = { resourceGroup, managedInstanceName };
      const name =
        output?.databaseName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getDatabase(subscriptionId, scope, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const scope: InstanceScope = {
        resourceGroup: news.resourceGroup,
        managedInstanceName: news.managedInstance,
      };
      const name =
        news.name ?? output?.databaseName ?? (yield* createChildName(id));
      const tags = yield* desiredTags(id, news.tags);
      const get = getDatabase(subscriptionId, scope, name);

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation; the database must
      // live in its instance's location.
      if (observed === undefined) {
        const instance = yield* orUndefinedIfNotFound(
          sql.GetManagedInstance(instancePath(subscriptionId, scope)),
        );
        const location =
          news.location ??
          output?.location ??
          instance?.location ??
          (yield* AzureEnvironment.current).location;
        yield* sql.ManagedDatabasesCreateOrUpdate({
          ...instancePath(subscriptionId, scope),
          databaseName: name,
          location,
          tags,
          properties: {
            collation: news.collation,
            catalogCollation: news.catalogCollation,
            isLedgerOn: news.isLedgerOn,
          },
        });
      }
      observed = yield* waitForProvisioned(
        `sql managed database ${name}`,
        get,
        statusOf,
        { interval: "10 seconds", times: 60 },
      );

      // Sync tags against the observed database.
      if (tagsDiffer(observed.tags, tags)) {
        yield* sql.UpdateManagedDatabase({
          ...instancePath(subscriptionId, scope),
          databaseName: name,
          tags,
        });
        observed = yield* waitForProvisioned(
          `sql managed database ${name} tags`,
          get,
          (db) => (tagsDiffer(db.tags, tags) ? "Updating" : statusOf(db)),
          { interval: "5 seconds", times: 60 },
        );
      }
      return toAttrs(scope, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sql.DeleteManagedDatabase({
          ...instancePath(subscriptionId, output),
          databaseName: output.databaseName,
        }),
      );
      yield* waitUntilGone(
        `sql managed database ${output.databaseName}`,
        getDatabase(subscriptionId, output, output.databaseName),
        { interval: "10 seconds", times: 60 },
      );
    }),
  });
