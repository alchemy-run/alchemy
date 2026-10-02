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
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { fieldsMatch, isManagedInstanceOwnedByStack, lower } from "./common.ts";
import { instancePath, type InstanceScope, syncSetting } from "./setting.ts";

/** The schedule is a singleton named `default`. */
const SETTING_NAME = "default";

/** A weekly window in which the managed instance runs. */
export interface StartStopScheduleItem {
  /** Day the instance starts. */
  startDay:
    | "Sunday"
    | "Monday"
    | "Tuesday"
    | "Wednesday"
    | "Thursday"
    | "Friday"
    | "Saturday";
  /** Time of day the instance starts, `HH:mm`. */
  startTime: string;
  /** Day the instance stops. */
  stopDay:
    | "Sunday"
    | "Monday"
    | "Tuesday"
    | "Wednesday"
    | "Thursday"
    | "Friday"
    | "Saturday";
  /** Time of day the instance stops, `HH:mm`. */
  stopTime: string;
}

const scheduleKey = (item: {
  startDay?: string;
  startTime?: string;
  stopDay?: string;
  stopTime?: string;
}) =>
  [
    lower(item.startDay),
    item.startTime,
    lower(item.stopDay),
    item.stopTime,
  ].join("|");

export interface StartStopManagedInstanceScheduleProps {
  /** Resource group of the managed instance. Changing it replaces the schedule. */
  resourceGroup: string;
  /** Name of the SQL managed instance. Changing it replaces the schedule. */
  managedInstance: string;
  /** Weekly windows in which the instance runs; it is stopped otherwise. */
  scheduleList: StartStopScheduleItem[];
  /**
   * Windows time zone of the schedule, e.g. `Pacific Standard Time`.
   * @default "UTC"
   */
  timeZoneId?: string;
  /** Description of the schedule. */
  description?: string;
}

export interface StartStopManagedInstanceSchedule extends Resource<
  "Azure.Sql.StartStopManagedInstanceSchedule",
  StartStopManagedInstanceScheduleProps,
  {
    /** ARM resource ID of the schedule. */
    scheduleId: string;
    /** Resource group of the managed instance. */
    resourceGroup: string;
    /** Name of the SQL managed instance. */
    managedInstanceName: string;
    /** Next scheduled action (`Start` or `Stop`). */
    nextRunAction: string | undefined;
    /** Time of the next scheduled action. */
    nextExecutionTime: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A start/stop schedule of an Azure SQL Managed Instance (General Purpose)
 * — runs the instance only in the given weekly windows to save compute
 * cost. Destroying the resource removes the schedule.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/managed-instance/instance-stop-start-how-to
 *
 * ### Scheduling Uptime
 * **Example:** Run on weekdays during office hours
 * ```typescript
 * yield* Azure.Sql.StartStopManagedInstanceSchedule("office-hours", {
 *   resourceGroup: group.resourceGroupName,
 *   managedInstance: instance.managedInstanceName,
 *   timeZoneId: "Pacific Standard Time",
 *   scheduleList: [
 *     { startDay: "Monday", startTime: "08:00", stopDay: "Monday", stopTime: "18:00" },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const StartStopManagedInstanceSchedule =
  Resource<StartStopManagedInstanceSchedule>(
    "Azure.Sql.StartStopManagedInstanceSchedule",
  );

type Observed = sql.GetStartStopManagedInstanceScheduleResponse;

const getSetting = (subscriptionId: string, scope: InstanceScope) =>
  orUndefinedIfNotFound(
    sql.GetStartStopManagedInstanceSchedule({
      ...instancePath(subscriptionId, scope),
      startStopScheduleName: SETTING_NAME,
    }),
  );

const toAttrs = (
  scope: InstanceScope,
  observed: Observed,
): StartStopManagedInstanceSchedule["Attributes"] => ({
  scheduleId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  managedInstanceName: scope.managedInstanceName,
  nextRunAction: observed.properties?.nextRunAction,
  nextExecutionTime: observed.properties?.nextExecutionTime,
});

export const StartStopManagedInstanceScheduleProvider = () =>
  Provider.succeed(StartStopManagedInstanceSchedule, {
    stables: ["scheduleId", "resourceGroup", "managedInstanceName"],

    // A singleton setting of its managed instance; it disappears with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.managedInstance) !== lower(output.managedInstanceName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const managedInstanceName =
        output?.managedInstanceName ?? olds?.managedInstance;
      if (resourceGroup === undefined || managedInstanceName === undefined) {
        return undefined;
      }
      const scope = { resourceGroup, managedInstanceName };
      const observed = yield* getSetting(subscriptionId, scope);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, observed);
      return output !== undefined ||
        (yield* isManagedInstanceOwnedByStack(
          subscriptionId,
          scope.resourceGroup,
          scope.managedInstanceName,
        ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const scope: InstanceScope = {
        resourceGroup: news.resourceGroup,
        managedInstanceName: news.managedInstance,
      };
      const desired = {
        scheduleList: news.scheduleList,
        timeZoneId: news.timeZoneId,
        description: news.description,
      };
      const fresh = yield* syncSetting({
        label: `sql managed instance start/stop schedule on ${scope.managedInstanceName}`,
        get: getSetting(subscriptionId, scope),
        converged: (observed) =>
          fieldsMatch(observed.properties, desired, ["scheduleList"]) &&
          JSON.stringify(
            (observed.properties?.scheduleList ?? []).map(scheduleKey).sort(),
          ) === JSON.stringify(desired.scheduleList.map(scheduleKey).sort()),
        put: sql.StartStopManagedInstanceSchedulesCreateOrUpdate({
          ...instancePath(subscriptionId, scope),
          startStopScheduleName: SETTING_NAME,
          properties: desired,
        }),
      });
      return toAttrs(scope, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sql.DeleteStartStopManagedInstanceSchedule({
          ...instancePath(subscriptionId, output),
          startStopScheduleName: SETTING_NAME,
        }),
      );
      yield* waitUntilGone(
        `sql managed instance start/stop schedule on ${output.managedInstanceName}`,
        getSetting(subscriptionId, output),
      );
    }),

    nuke: { singleton: true },
  });
