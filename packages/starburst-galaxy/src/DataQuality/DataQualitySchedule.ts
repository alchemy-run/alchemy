import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type { DataQualityScheduleWithQualityChecks } from "@distilled.cloud/starburst-galaxy/data_quality_schedule";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { changedFields, hasChanges } from "../internal.ts";
import type { Providers } from "../Providers.ts";

export interface DataQualityScheduleProps {
  /** ID of the catalog holding the table. Changing it replaces the schedule. */
  readonly catalogId: string;
  /** Schema holding the table. Changing it replaces the schedule. */
  readonly schemaName: string;
  /** Table whose checks run on the schedule. Changing it replaces the schedule. */
  readonly tableName: string;
  /** ID of the cluster that evaluates the checks. */
  readonly clusterId: string;
  /** ID of the role the evaluation runs as. It needs `UseCluster` on the cluster. */
  readonly roleId: string;
  /** Cron expression of the evaluations, e.g. `0 6 * * *`. */
  readonly schedule: string;
  /**
   * IANA time zone of `schedule`.
   * @default "UTC"
   */
  readonly timezone?: string;
}

export interface DataQualityScheduleAttributes {
  /** Galaxy's schedule ID. */
  readonly dataQualityScheduleId: string;
  /** Catalog holding the table. */
  readonly catalogId: string;
  /** Schema holding the table. */
  readonly schemaName: string;
  /** Table whose checks run on the schedule. */
  readonly tableName: string;
  /** Cluster that evaluates the checks. */
  readonly clusterId: string;
  /** Role the evaluation runs as. */
  readonly roleId: string;
  /** Cron expression. */
  readonly schedule: string;
  /** Time zone of the schedule. */
  readonly timezone: string;
  /** When the checks run next. */
  readonly nextExecution: string;
  /** Whether Galaxy runs the schedule. */
  readonly enabled: boolean;
  /** IDs of the checks the schedule evaluates (every check on the table). */
  readonly dataQualityCheckIds: ReadonlyArray<string>;
}

export type DataQualitySchedule = Resource<
  "StarburstGalaxy.DataQuality.DataQualitySchedule",
  DataQualityScheduleProps,
  DataQualityScheduleAttributes,
  never,
  Providers
>;

/**
 * When Starburst Galaxy evaluates the data quality checks of one table:
 * a cron schedule, the cluster that runs them and the role they run as.
 * A table has at most one schedule.
 *
 * Cluster, role, schedule and time zone update in place; the table
 * replaces the schedule. Schedules have no name: only state knows a
 * schedule is Alchemy's, so it is never adopted or listed for nuke.
 * Each run starts the cluster. The role must be able to use the cluster
 * and read the table: Galaxy answers NotFound ("Table: [...] not found")
 * for a table the role can't see.
 *
 * @see https://docs.starburst.io/starburst-galaxy/data-engineering/optimization-performance-and-quality/observability/profile-and-quality.html
 *
 * ### Evaluating a table's checks every morning
 * **Example:** On a cluster that suspends after a minute
 * ```typescript
 * const shop = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "shop" });
 * const cluster = yield* StarburstGalaxy.Cluster.Cluster("Quality", {
 *   cloudRegionId: "aws-us-east1",
 *   catalogs: [shop.catalogId],
 *   autoSuspend: "1 minute",
 * });
 * const role = yield* StarburstGalaxy.Role.Role("QualityRunner", {});
 * const useCluster = yield* StarburstGalaxy.Role.RolePrivilege("QualityUsesCluster", {
 *   role: role.roleId,
 *   privilege: "UseCluster",
 *   entity: { kind: "Cluster", clusterId: cluster.clusterId },
 * });
 * const readOrders = yield* StarburstGalaxy.Role.RolePrivilege("QualityReadsOrders", {
 *   role: useCluster.roleId,
 *   privilege: "Select",
 *   entity: { kind: "Table", catalogId: shop.catalogId, schemaName: "sales", tableName: "orders" },
 * });
 * yield* StarburstGalaxy.DataQuality.DataQualitySchedule("OrdersEveryMorning", {
 *   catalogId: shop.catalogId,
 *   schemaName: "sales",
 *   tableName: "orders",
 *   clusterId: cluster.clusterId,
 *   roleId: readOrders.roleId,
 *   schedule: "0 6 * * *",
 *   timezone: "Europe/Paris",
 * });
 * ```
 *
 * @resource
 * @product Data quality
 */
export const DataQualitySchedule = Resource<DataQualitySchedule>(
  "StarburstGalaxy.DataQuality.DataQualitySchedule",
);

interface TableIds {
  readonly catalogId: string;
  readonly schemaId: string;
  readonly tableId: string;
}

const idsOf = (table: {
  readonly catalogId: string;
  readonly schemaName: string;
  readonly tableName: string;
}): TableIds => ({
  catalogId: table.catalogId,
  schemaId: table.schemaName,
  tableId: table.tableName,
});

const toAttributes = (
  ids: TableIds,
  schedule: DataQualityScheduleWithQualityChecks,
): DataQualityScheduleAttributes => ({
  dataQualityScheduleId: schedule.dataQualityScheduleId,
  catalogId: ids.catalogId,
  schemaName: ids.schemaId,
  tableName: ids.tableId,
  clusterId: schedule.clusterId,
  roleId: schedule.roleId,
  schedule: schedule.cronExpression,
  timezone: schedule.timezone,
  nextExecution: schedule.nextExecution,
  enabled: schedule.enabled,
  dataQualityCheckIds: schedule.dataQualityChecks.map((check) => check.dataQualityCheckId),
});

/** The table's schedule; `undefined` when it has none (or the table is gone). */
const observe = (ids: TableIds) =>
  galaxy.dataQualitySchedule
    .getDataQualitySchedule(ids)
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

export const DataQualityScheduleProvider = () =>
  Provider.succeed(DataQualitySchedule, {
    stables: ["dataQualityScheduleId", "catalogId", "schemaName", "tableName"],

    nuke: { skip: true },

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return undefined;
      if (
        news.catalogId !== olds.catalogId ||
        news.schemaName !== olds.schemaName ||
        news.tableName !== olds.tableName
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      // No name to carry a marker: only state knows a schedule is ours.
      if (output === undefined) return undefined;
      const ids = idsOf(output);
      const schedule = yield* observe(ids);
      return schedule === undefined ? undefined : toAttributes(ids, schedule);
    }),

    reconcile: Effect.fn(function* ({ news, session }) {
      const ids = idsOf(news);
      const desired = {
        clusterId: news.clusterId,
        roleId: news.roleId,
        cronExpression: news.schedule,
        timezone: news.timezone ?? "UTC",
      };

      // Observe: one schedule per table.
      const observed = yield* observe(ids);

      // Ensure
      if (observed === undefined) {
        yield* session.note(`Scheduling the checks of ${news.schemaName}.${news.tableName}...`);
        yield* galaxy.dataQualitySchedule.createDataQualitySchedule({ ...ids, ...desired });
      } else {
        // Sync
        const delta = changedFields(observed, desired);
        if (hasChanges(delta)) {
          yield* session.note(
            `Updating the check schedule of ${news.schemaName}.${news.tableName}...`,
          );
          yield* galaxy.dataQualitySchedule.updateDataQualitySchedule({
            ...ids,
            ...delta,
            dataQualityScheduleId: observed.dataQualityScheduleId,
          });
        }
      }

      // The write responses omit the checks: read the schedule back.
      const schedule = yield* galaxy.dataQualitySchedule.getDataQualitySchedule(ids);
      return toAttributes(ids, schedule);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* galaxy.dataQualitySchedule
        .deleteDataQualitySchedule({
          ...idsOf(output),
          dataQualityScheduleId: output.dataQualityScheduleId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: () => Effect.succeed([]),
  });
