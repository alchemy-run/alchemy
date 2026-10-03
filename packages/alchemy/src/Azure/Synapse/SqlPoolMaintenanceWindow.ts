import * as synapse from "@distilled.cloud/azure/synapse";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { ensureRegistered, orUndefinedIfNotFound } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  fieldsMatch,
  isWorkspaceOwnedByStack,
  type SqlPoolChildAttrs,
  sqlPoolChildMoved,
  type SqlPoolChildProps,
  sqlPoolChildRef,
  sqlPoolWhere,
  syncSetting,
} from "./common.ts";

/** The setting is a singleton named `current`. */
const SETTING_NAME = "current";

export interface SqlPoolMaintenanceWindowProps extends SqlPoolChildProps {
  /**
   * Maintenance windows. Azure requires two windows per week (one on
   * Saturday–Sunday and one Tuesday–Thursday), each 3 to 8 hours.
   */
  timeRanges: {
    /** Day of week, e.g. `Saturday`. */
    dayOfWeek:
      | "Sunday"
      | "Monday"
      | "Tuesday"
      | "Wednesday"
      | "Thursday"
      | "Friday"
      | "Saturday";
    /** Start time (UTC) as `HH:mm:ss`, e.g. `00:00:00`. */
    startTime: string;
    /** ISO 8601 duration, e.g. `PT3H`. */
    duration: string;
  }[];
}

export interface SqlPoolMaintenanceWindow extends Resource<
  "Azure.Synapse.SqlPoolMaintenanceWindow",
  SqlPoolMaintenanceWindowProps,
  SqlPoolChildAttrs & {
    /** ARM resource ID of the setting. */
    settingId: string;
    /** Configured maintenance windows. */
    timeRanges: synapse.MaintenanceWindowTimeRange[];
  },
  never,
  Providers
> {}

/**
 * The maintenance schedule of a dedicated SQL pool — the two weekly
 * windows in which Azure may apply updates.
 *
 * This is a singleton setting that always exists on a pool. Azure cannot
 * remove a schedule, so destroying the resource leaves the last windows in
 * place.
 *
 * @see https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/maintenance-scheduling
 *
 * ### Scheduling Maintenance
 * **Example:** Weekend and mid-week windows
 * ```typescript
 * yield* Azure.Synapse.SqlPoolMaintenanceWindow("maintenance", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   sqlPool: pool.sqlPoolName,
 *   timeRanges: [
 *     { dayOfWeek: "Saturday", startTime: "00:00:00", duration: "PT3H" },
 *     { dayOfWeek: "Wednesday", startTime: "01:00:00", duration: "PT3H" },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const SqlPoolMaintenanceWindow = Resource<SqlPoolMaintenanceWindow>(
  "Azure.Synapse.SqlPoolMaintenanceWindow",
);

type Observed = synapse.GetSqlPoolMaintenanceWindowsResponse;

const getSetting = (subscriptionId: string, ref: SqlPoolChildAttrs) =>
  orUndefinedIfNotFound(
    synapse.GetSqlPoolMaintenanceWindows({
      ...sqlPoolWhere(subscriptionId, ref),
      maintenanceWindowName: SETTING_NAME,
    }),
  );

const toAttrs = (
  ref: SqlPoolChildAttrs,
  setting: Observed,
): SqlPoolMaintenanceWindow["Attributes"] => ({
  ...ref,
  settingId: setting.id ?? "",
  timeRanges: [...(setting.properties?.timeRanges ?? [])],
});

const settingSync = (
  subscriptionId: string,
  ref: SqlPoolChildAttrs,
  desired: synapse.MaintenanceWindowsProperties,
) => ({
  label: `synapse maintenance window on sql pool ${ref.sqlPoolName}`,
  get: getSetting(subscriptionId, ref),
  matches: (setting: Observed) => fieldsMatch(setting.properties, desired),
  put: synapse.SqlPoolMaintenanceWindowsCreateOrUpdate({
    ...sqlPoolWhere(subscriptionId, ref),
    maintenanceWindowName: SETTING_NAME,
    properties: desired,
  }),
});

export const SqlPoolMaintenanceWindowProvider = () =>
  Provider.succeed(SqlPoolMaintenanceWindow, {
    stables: ["settingId", "workspaceName", "resourceGroup", "sqlPoolName"],

    // A per-pool singleton setting; it disappears with its pool.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (sqlPoolChildMoved(news, output)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const ref = sqlPoolChildRef(olds, output);
      if (ref === undefined) return undefined;
      const observed = yield* getSetting(subscriptionId, ref);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(ref, observed);
      return output !== undefined ||
        (yield* isWorkspaceOwnedByStack(
          subscriptionId,
          ref.resourceGroup,
          ref.workspaceName,
        ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Synapse");
      const ref = {
        resourceGroup: news.resourceGroup,
        workspaceName: news.workspace,
        sqlPoolName: news.sqlPool,
      };
      const fresh = yield* syncSetting(
        settingSync(subscriptionId, ref, { timeRanges: news.timeRanges }),
      );
      return toAttrs(ref, fresh);
    }),

    // The schedule cannot be removed; Azure keeps the last windows.
    delete: Effect.fn(function* () {}),

    nuke: { singleton: true },
  });
