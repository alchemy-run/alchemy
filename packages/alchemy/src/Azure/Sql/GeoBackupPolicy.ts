import * as sql from "@distilled.cloud/azure/sql";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { fieldsMatch, isServerOwnedByStack, lower } from "./common.ts";
import { databasePath, type DatabaseScope, syncSetting } from "./setting.ts";

/** The policy is a singleton named `Default`. */
const SETTING_NAME = "Default";

export interface GeoBackupPolicyProps {
  /** Resource group of the server. Changing it replaces the policy. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the policy. */
  server: string;
  /** Name of the database. Changing it replaces the policy. */
  database: string;
  /**
   * Whether geo-redundant backups are taken. Azure only acts on it for
   * data warehouses (dedicated SQL pools, `DW*` SKUs).
   */
  state: "Enabled" | "Disabled";
}

export interface GeoBackupPolicy extends Resource<
  "Azure.Sql.GeoBackupPolicy",
  GeoBackupPolicyProps,
  {
    /** ARM resource ID of the policy. */
    policyId: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Name of the database. */
    databaseName: string;
    /** Observed state. */
    state: string;
    /** Storage type of the geo backups. */
    storageType: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The geo-backup policy of an Azure SQL database — whether a
 * geo-redundant backup is taken every day. Azure only acts on it for
 * dedicated SQL pools (data warehouses); other databases report it but
 * use their backup storage redundancy instead.
 *
 * This is a singleton setting that always exists on a data warehouse.
 * Destroying the resource re-enables geo backups (Azure's default).
 *
 * @see https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/backup-and-restore
 *
 * ### Disabling Geo Backups
 * **Example:** Turn off geo backups for a dev warehouse
 * ```typescript
 * yield* Azure.Sql.GeoBackupPolicy("geo-backup", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   database: database.databaseName,
 *   state: "Disabled",
 * });
 * ```
 *
 * @resource
 */
export const GeoBackupPolicy = Resource<GeoBackupPolicy>(
  "Azure.Sql.GeoBackupPolicy",
);

type Observed = sql.GetGeoBackupPolicyResponse;

const getSetting = (subscriptionId: string, scope: DatabaseScope) =>
  orUndefinedIfNotFound(
    sql.GetGeoBackupPolicy({
      ...databasePath(subscriptionId, scope),
      geoBackupPolicyName: SETTING_NAME,
    }),
  );

const toAttrs = (
  scope: DatabaseScope,
  observed: Observed,
): GeoBackupPolicy["Attributes"] => ({
  policyId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  serverName: scope.serverName,
  databaseName: scope.databaseName,
  state: observed.properties?.state ?? "Enabled",
  storageType: observed.properties?.storageType,
});

export const GeoBackupPolicyProvider = () =>
  Provider.succeed(GeoBackupPolicy, {
    stables: ["policyId", "resourceGroup", "serverName", "databaseName"],

    // A singleton setting of its database; it disappears with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.server) !== lower(output.serverName) ||
        lower(news.database) !== lower(output.databaseName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.serverName ?? olds?.server;
      const databaseName = output?.databaseName ?? olds?.database;
      if (
        resourceGroup === undefined ||
        serverName === undefined ||
        databaseName === undefined
      ) {
        return undefined;
      }
      const scope = { resourceGroup, serverName, databaseName };
      const observed = yield* getSetting(subscriptionId, scope);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, observed);
      return output !== undefined ||
        (yield* isServerOwnedByStack(
          subscriptionId,
          scope.resourceGroup,
          scope.serverName,
        ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const scope: DatabaseScope = {
        resourceGroup: news.resourceGroup,
        serverName: news.server,
        databaseName: news.database,
      };
      const desired = { state: news.state };
      const fresh = yield* syncSetting({
        label: `sql geo backup policy on ${scope.databaseName}`,
        get: getSetting(subscriptionId, scope),
        converged: (observed) =>
          lower(observed.properties?.state) === lower(desired.state),
        put: sql.GeoBackupPoliciesCreateOrUpdate({
          ...databasePath(subscriptionId, scope),
          geoBackupPolicyName: SETTING_NAME,
          properties: desired,
        }),
      });
      return toAttrs(scope, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const label = `sql geo backup policy on ${output.databaseName}`;
      if ((yield* getSetting(subscriptionId, output)) === undefined) return;
      // The policy cannot be removed; re-enable geo backups (Azure's default).
      yield* ignoreNotFound(
        syncSetting({
          label,
          get: getSetting(subscriptionId, output),
          converged: (observed) =>
            fieldsMatch(observed.properties, { state: "Enabled" }),
          put: sql.GeoBackupPoliciesCreateOrUpdate({
            ...databasePath(subscriptionId, output),
            geoBackupPolicyName: SETTING_NAME,
            properties: { state: "Enabled" },
          }),
        }),
      );
    }),

    nuke: { singleton: true },
  });
