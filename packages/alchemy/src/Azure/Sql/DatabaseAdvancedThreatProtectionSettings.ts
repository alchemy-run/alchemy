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

/** The setting is a singleton named `Default`. */
const SETTING_NAME = "Default";

export interface DatabaseAdvancedThreatProtectionSettingsProps {
  /** Resource group of the server. Changing it replaces the setting. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the setting. */
  server: string;
  /** Name of the database. Changing it replaces the setting. */
  database: string;
  /**
   * Whether Advanced Threat Protection (Microsoft Defender for SQL) is
   * enabled. Enabling it is billed under Microsoft Defender for SQL.
   */
  state: "Enabled" | "Disabled";
}

export interface DatabaseAdvancedThreatProtectionSettings extends Resource<
  "Azure.Sql.DatabaseAdvancedThreatProtectionSettings",
  DatabaseAdvancedThreatProtectionSettingsProps,
  {
    /** ARM resource ID of the setting. */
    settingId: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Name of the database. */
    databaseName: string;
    /** Observed state: `New`, `Enabled`, or `Disabled`. */
    state: string;
    /** When the setting was first enabled, if ever. */
    creationTime: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Advanced Threat Protection (Microsoft Defender for SQL) for an Azure SQL database
 * — detects anomalous activity such as SQL injection and brute-force
 * logins.
 *
 * This is a singleton setting that always exists on its parent.
 * Destroying the resource disables protection again.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/threat-detection-overview
 *
 * ### Enabling Threat Protection
 * **Example:** Enable Advanced Threat Protection
 * ```typescript
 * yield* Azure.Sql.DatabaseAdvancedThreatProtectionSettings("atp", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   database: database.databaseName,
 *   state: "Enabled",
 * });
 * ```
 *
 * @resource
 */
export const DatabaseAdvancedThreatProtectionSettings =
  Resource<DatabaseAdvancedThreatProtectionSettings>(
    "Azure.Sql.DatabaseAdvancedThreatProtectionSettings",
  );

type Observed = sql.GetDatabaseAdvancedThreatProtectionSettingsResponse;

const getSetting = (subscriptionId: string, scope: DatabaseScope) =>
  orUndefinedIfNotFound(
    sql.GetDatabaseAdvancedThreatProtectionSettings({
      ...databasePath(subscriptionId, scope),
      advancedThreatProtectionName: SETTING_NAME,
    }),
  );

const toAttrs = (
  scope: DatabaseScope,
  observed: Observed,
): DatabaseAdvancedThreatProtectionSettings["Attributes"] => ({
  settingId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  serverName: scope.serverName,
  databaseName: scope.databaseName,
  state: observed.properties?.state ?? "New",
  creationTime: observed.properties?.creationTime,
});

export const DatabaseAdvancedThreatProtectionSettingsProvider = () =>
  Provider.succeed(DatabaseAdvancedThreatProtectionSettings, {
    stables: ["settingId", "resourceGroup", "serverName", "databaseName"],

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
        label: `sql an Azure SQL database threat protection on ${scope.databaseName}`,
        get: getSetting(subscriptionId, scope),
        converged: (observed) =>
          lower(observed.properties?.state) === lower(desired.state),
        put: sql.DatabaseAdvancedThreatProtectionSettingsCreateOrUpdate({
          ...databasePath(subscriptionId, scope),
          advancedThreatProtectionName: SETTING_NAME,
          properties: desired,
        }),
      });
      return toAttrs(scope, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const label = `sql an Azure SQL database threat protection on ${output.databaseName}`;
      if ((yield* getSetting(subscriptionId, output)) === undefined) return;
      // The setting cannot be removed; disable it.
      yield* ignoreNotFound(
        syncSetting({
          label,
          get: getSetting(subscriptionId, output),
          converged: (observed) =>
            fieldsMatch(observed.properties, { state: "Disabled" }),
          put: sql.DatabaseAdvancedThreatProtectionSettingsCreateOrUpdate({
            ...databasePath(subscriptionId, output),
            advancedThreatProtectionName: SETTING_NAME,
            properties: { state: "Disabled" },
          }),
        }),
      );
    }),

    nuke: { singleton: true },
  });
