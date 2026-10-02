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
import { isServerOwnedByStack, lower } from "./common.ts";
import {
  databasePath,
  type DatabaseScope,
  retryInProgress,
  syncSetting,
} from "./setting.ts";

/** The setting is a singleton named `current`. */
const SETTING_NAME = "current";

/** A weekly window in which maintenance may happen. */
export interface MaintenanceWindowTimeRange {
  /** Day of the week the window starts. */
  dayOfWeek:
    | "Sunday"
    | "Monday"
    | "Tuesday"
    | "Wednesday"
    | "Thursday"
    | "Friday"
    | "Saturday";
  /** Start time of day in UTC, e.g. `"00:00:00"`. */
  startTime: string;
  /** ISO 8601 duration of the window, e.g. `"PT8H"`. */
  duration: string;
}

export interface MaintenanceWindowProps {
  /** Resource group of the server. Changing it replaces the setting. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the setting. */
  server: string;
  /** Name of the database. Changing it replaces the setting. */
  database: string;
  /**
   * Weekly time ranges in which planned maintenance may happen. Allowed
   * values come from the database's maintenance window options.
   */
  timeRanges: MaintenanceWindowTimeRange[];
}

export interface MaintenanceWindow extends Resource<
  "Azure.Sql.MaintenanceWindow",
  MaintenanceWindowProps,
  {
    /** ARM resource ID of the setting. */
    settingId: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Name of the database. */
    databaseName: string;
    /** Observed time ranges. */
    timeRanges: MaintenanceWindowTimeRange[];
  },
  never,
  Providers
> {}

/**
 * Custom maintenance windows of an Azure SQL database — the weekly time
 * ranges in which planned maintenance may happen. Only databases whose
 * maintenance configuration supports custom windows accept them; read
 * the allowed values from the database's maintenance window options.
 *
 * Destroying the resource clears the custom windows.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/maintenance-window
 *
 * ### Scheduling Maintenance
 * **Example:** Allow maintenance on Saturday nights
 * ```typescript
 * yield* Azure.Sql.MaintenanceWindow("maintenance", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   database: database.databaseName,
 *   timeRanges: [
 *     { dayOfWeek: "Saturday", startTime: "22:00:00", duration: "PT8H" },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const MaintenanceWindow = Resource<MaintenanceWindow>(
  "Azure.Sql.MaintenanceWindow",
);

type Observed = sql.GetMaintenanceWindowsResponse;

const getSetting = (subscriptionId: string, scope: DatabaseScope) =>
  orUndefinedIfNotFound(
    sql.GetMaintenanceWindows({
      ...databasePath(subscriptionId, scope),
      maintenanceWindowName: SETTING_NAME,
    }),
  );

const toAttrs = (
  scope: DatabaseScope,
  observed: Observed,
): MaintenanceWindow["Attributes"] => ({
  settingId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  serverName: scope.serverName,
  databaseName: scope.databaseName,
  timeRanges: (observed.properties?.timeRanges ?? []).map((range) => ({
    dayOfWeek: (range.dayOfWeek ??
      "Sunday") as MaintenanceWindowTimeRange["dayOfWeek"],
    startTime: range.startTime ?? "",
    duration: range.duration ?? "",
  })),
});

export const MaintenanceWindowProvider = () =>
  Provider.succeed(MaintenanceWindow, {
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
      const desired = { timeRanges: news.timeRanges };
      const fresh = yield* syncSetting({
        label: `sql maintenance window on ${scope.databaseName}`,
        get: getSetting(subscriptionId, scope),
        converged: (observed) =>
          JSON.stringify(
            (observed.properties?.timeRanges ?? []).map((r) => [
              lower(r.dayOfWeek),
              r.startTime,
              r.duration,
            ]),
          ) ===
          JSON.stringify(
            desired.timeRanges.map((r) => [
              lower(r.dayOfWeek),
              r.startTime,
              r.duration,
            ]),
          ),
        put: sql.MaintenanceWindowsCreateOrUpdate({
          ...databasePath(subscriptionId, scope),
          maintenanceWindowName: SETTING_NAME,
          properties: desired,
        }),
      });
      return toAttrs(scope, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // The setting cannot be removed; clear the custom windows.
      yield* ignoreNotFound(
        retryInProgress(
          sql.MaintenanceWindowsCreateOrUpdate({
            ...databasePath(subscriptionId, output),
            maintenanceWindowName: SETTING_NAME,
            properties: { timeRanges: [] },
          }),
        ),
      );
    }),

    nuke: { singleton: true },
  });
