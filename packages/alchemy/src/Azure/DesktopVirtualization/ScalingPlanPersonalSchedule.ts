import * as desktopvirtualization from "@distilled.cloud/azure/desktopvirtualization";
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
import { createAvdName, deltaOf, ownedByStage } from "./Common.ts";
import { getScalingPlan } from "./ScalingPlan.ts";
import type {
  ScalingDayOfWeek,
  ScalingTime,
} from "./ScalingPlanPooledSchedule.ts";

/** Whether Start VM On Connect is on during a phase. */
export type ScalingStartVMOnConnect = "Enable" | "Disable";

/** What happens to a personal session host after a disconnect or logoff. */
export type ScalingSessionAction = "None" | "Deallocate" | "Hibernate";

export interface ScalingPlanPersonalScheduleProps {
  /** Resource group of the scaling plan. Changing it replaces the schedule. */
  resourceGroup: string;
  /** Name of a `Personal` scaling plan. Changing it replaces the schedule. */
  scalingPlan: string;
  /**
   * Schedule name, 1-64 letters, digits, `@`, `.`, `-`, `_`, or spaces. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the schedule.
   */
  name?: string;
  /** Days the schedule applies to. Days may not overlap other schedules of the plan. */
  daysOfWeek: ScalingDayOfWeek[];
  /** Start of the ramp-up phase. */
  rampUpStartTime: ScalingTime;
  /** Which session hosts start at ramp-up. @default "None" */
  rampUpAutoStartHosts?: "None" | "WithAssignedUser" | "All";
  /** Start VM On Connect during ramp-up. @default "Enable" */
  rampUpStartVMOnConnect?: ScalingStartVMOnConnect;
  /** Action after a user disconnects during ramp-up. @default "None" */
  rampUpActionOnDisconnect?: "None" | "Deallocate";
  /** Minutes to wait after a disconnect during ramp-up. */
  rampUpMinutesToWaitOnDisconnect?: number;
  /** Action after a user logs off during ramp-up. @default "None" */
  rampUpActionOnLogoff?: "None" | "Deallocate";
  /** Minutes to wait after a logoff during ramp-up. */
  rampUpMinutesToWaitOnLogoff?: number;
  /** Start of the peak phase. */
  peakStartTime: ScalingTime;
  /** Start VM On Connect during peak. @default "Enable" */
  peakStartVMOnConnect?: ScalingStartVMOnConnect;
  /** Action after a user disconnects during peak. @default "None" */
  peakActionOnDisconnect?: "None" | "Deallocate";
  /** Minutes to wait after a disconnect during peak. */
  peakMinutesToWaitOnDisconnect?: number;
  /** Action after a user logs off during peak. @default "None" */
  peakActionOnLogoff?: "None" | "Deallocate";
  /** Minutes to wait after a logoff during peak. */
  peakMinutesToWaitOnLogoff?: number;
  /** Start of the ramp-down phase. */
  rampDownStartTime: ScalingTime;
  /** Start VM On Connect during ramp-down. @default "Enable" */
  rampDownStartVMOnConnect?: ScalingStartVMOnConnect;
  /** Action after a user disconnects during ramp-down. @default "None" */
  rampDownActionOnDisconnect?: "None" | "Deallocate";
  /** Minutes to wait after a disconnect during ramp-down. */
  rampDownMinutesToWaitOnDisconnect?: number;
  /** Action after a user logs off during ramp-down. @default "None" */
  rampDownActionOnLogoff?: ScalingSessionAction;
  /** Minutes to wait after a logoff during ramp-down. */
  rampDownMinutesToWaitOnLogoff?: number;
  /** Start of the off-peak phase. */
  offPeakStartTime: ScalingTime;
  /** Start VM On Connect during off-peak. @default "Enable" */
  offPeakStartVMOnConnect?: ScalingStartVMOnConnect;
  /** Action after a user disconnects during off-peak. @default "None" */
  offPeakActionOnDisconnect?: ScalingSessionAction;
  /** Minutes to wait after a disconnect during off-peak. */
  offPeakMinutesToWaitOnDisconnect?: number;
  /** Action after a user logs off during off-peak. @default "None" */
  offPeakActionOnLogoff?: ScalingSessionAction;
  /** Minutes to wait after a logoff during off-peak. */
  offPeakMinutesToWaitOnLogoff?: number;
}

export interface ScalingPlanPersonalSchedule extends Resource<
  "Azure.DesktopVirtualization.ScalingPlanPersonalSchedule",
  ScalingPlanPersonalScheduleProps,
  {
    /** Name of the schedule. */
    scheduleName: string;
    /** ARM resource ID of the schedule. */
    scheduleId: string;
    /** Resource group of the scaling plan. */
    resourceGroup: string;
    /** Name of the scaling plan. */
    scalingPlan: string;
    /** Days the schedule applies to. */
    daysOfWeek: string[];
  },
  never,
  Providers
> {}

/**
 * A schedule of a `Personal` Azure Virtual Desktop scaling plan: when
 * personal session hosts start, and whether they are deallocated or
 * hibernated after users disconnect or log off, per phase.
 *
 * Schedules have no tags; Alchemy treats a schedule as owned when its
 * scaling plan carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/virtual-desktop/autoscale-scaling-plan
 *
 * ### Creating a Schedule
 * **Example:** Deallocate idle personal desktops on weekdays
 * ```typescript
 * const weekdays = yield* Azure.DesktopVirtualization.ScalingPlanPersonalSchedule(
 *   "weekdays",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     scalingPlan: plan.scalingPlanName,
 *     daysOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
 *     rampUpStartTime: { hour: 7, minute: 0 },
 *     rampUpAutoStartHosts: "WithAssignedUser",
 *     peakStartTime: { hour: 9, minute: 0 },
 *     peakActionOnDisconnect: "Deallocate",
 *     peakMinutesToWaitOnDisconnect: 60,
 *     rampDownStartTime: { hour: 18, minute: 0 },
 *     offPeakStartTime: { hour: 20, minute: 0 },
 *     offPeakActionOnLogoff: "Deallocate",
 *   },
 * );
 * ```
 *
 * @resource
 */
export const ScalingPlanPersonalSchedule =
  Resource<ScalingPlanPersonalSchedule>(
    "Azure.DesktopVirtualization.ScalingPlanPersonalSchedule",
  );

type ObservedSchedule =
  desktopvirtualization.GetScalingPlanPersonalScheduleResponse;

const getSchedule = (
  subscriptionId: string,
  resourceGroupName: string,
  scalingPlanName: string,
  scalingPlanScheduleName: string,
) =>
  orUndefinedIfNotFound(
    desktopvirtualization.GetScalingPlanPersonalSchedule({
      subscriptionId,
      resourceGroupName,
      scalingPlanName,
      scalingPlanScheduleName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  scalingPlan: string,
  name: string,
  schedule: ObservedSchedule,
): ScalingPlanPersonalSchedule["Attributes"] => ({
  scheduleName: name,
  scheduleId: schedule.id ?? "",
  resourceGroup,
  scalingPlan,
  daysOfWeek: schedule.properties?.daysOfWeek ?? [],
});

const desiredProperties = (news: ScalingPlanPersonalScheduleProps) => ({
  daysOfWeek: news.daysOfWeek,
  rampUpStartTime: news.rampUpStartTime,
  rampUpAutoStartHosts: news.rampUpAutoStartHosts ?? "None",
  rampUpStartVMOnConnect: news.rampUpStartVMOnConnect ?? "Enable",
  rampUpActionOnDisconnect: news.rampUpActionOnDisconnect ?? "None",
  rampUpMinutesToWaitOnDisconnect: news.rampUpMinutesToWaitOnDisconnect,
  rampUpActionOnLogoff: news.rampUpActionOnLogoff ?? "None",
  rampUpMinutesToWaitOnLogoff: news.rampUpMinutesToWaitOnLogoff,
  peakStartTime: news.peakStartTime,
  peakStartVMOnConnect: news.peakStartVMOnConnect ?? "Enable",
  peakActionOnDisconnect: news.peakActionOnDisconnect ?? "None",
  peakMinutesToWaitOnDisconnect: news.peakMinutesToWaitOnDisconnect,
  peakActionOnLogoff: news.peakActionOnLogoff ?? "None",
  peakMinutesToWaitOnLogoff: news.peakMinutesToWaitOnLogoff,
  rampDownStartTime: news.rampDownStartTime,
  rampDownStartVMOnConnect: news.rampDownStartVMOnConnect ?? "Enable",
  rampDownActionOnDisconnect: news.rampDownActionOnDisconnect ?? "None",
  rampDownMinutesToWaitOnDisconnect: news.rampDownMinutesToWaitOnDisconnect,
  rampDownActionOnLogoff: news.rampDownActionOnLogoff ?? "None",
  rampDownMinutesToWaitOnLogoff: news.rampDownMinutesToWaitOnLogoff,
  offPeakStartTime: news.offPeakStartTime,
  offPeakStartVMOnConnect: news.offPeakStartVMOnConnect ?? "Enable",
  offPeakActionOnDisconnect: news.offPeakActionOnDisconnect ?? "None",
  offPeakMinutesToWaitOnDisconnect: news.offPeakMinutesToWaitOnDisconnect,
  offPeakActionOnLogoff: news.offPeakActionOnLogoff ?? "None",
  offPeakMinutesToWaitOnLogoff: news.offPeakMinutesToWaitOnLogoff,
});

export const ScalingPlanPersonalScheduleProvider = () =>
  Provider.succeed(ScalingPlanPersonalSchedule, {
    stables: ["scheduleName", "scheduleId", "resourceGroup", "scalingPlan"],

    // Schedules are removed with their scaling plan.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.scalingPlan.toLowerCase() !== output.scalingPlan.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.scheduleName.toLowerCase())
      ) {
        // A plan allows one schedule per weekday, so the old schedule must
        // go before its replacement is created.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const scalingPlan = output?.scalingPlan ?? olds?.scalingPlan;
      if (resourceGroup === undefined || scalingPlan === undefined) {
        return undefined;
      }
      const name =
        output?.scheduleName ?? olds?.name ?? (yield* createAvdName(id, 64));
      const observed = yield* getSchedule(
        subscriptionId,
        resourceGroup,
        scalingPlan,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, scalingPlan, name, observed);
      const parent = yield* getScalingPlan(
        subscriptionId,
        resourceGroup,
        scalingPlan,
      );
      return (yield* ownedByStage(parent?.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(
        subscriptionId,
        "Microsoft.DesktopVirtualization",
      );
      const { resourceGroup, scalingPlan } = news;
      const name =
        news.name ?? output?.scheduleName ?? (yield* createAvdName(id, 64));
      const desired = desiredProperties(news);
      const request = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        scalingPlanName: scalingPlan,
        scalingPlanScheduleName: name,
      };

      // Observe.
      let observed: ObservedSchedule | undefined = yield* getSchedule(
        subscriptionId,
        resourceGroup,
        scalingPlan,
        name,
      );

      if (observed === undefined) {
        // Ensure: the PUT is synchronous.
        observed =
          yield* desktopvirtualization.CreateScalingPlanPersonalSchedule({
            ...request,
            properties: desired,
          });
      } else {
        // Sync: PATCH only the observed deltas.
        const delta = deltaOf(desired, observed.properties);
        if (delta !== undefined) {
          observed =
            yield* desktopvirtualization.UpdateScalingPlanPersonalSchedule({
              ...request,
              properties: delta,
            });
        }
      }

      return toAttrs(resourceGroup, scalingPlan, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        desktopvirtualization.DeleteScalingPlanPersonalSchedule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          scalingPlanName: output.scalingPlan,
          scalingPlanScheduleName: output.scheduleName,
        }),
      );
      yield* waitUntilGone(
        `scaling plan schedule ${output.scheduleName}`,
        getSchedule(
          subscriptionId,
          output.resourceGroup,
          output.scalingPlan,
          output.scheduleName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.DesktopVirtualization.ScalingPlan",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
