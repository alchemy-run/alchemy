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

export type ScalingDayOfWeek =
  | "Monday"
  | "Tuesday"
  | "Wednesday"
  | "Thursday"
  | "Friday"
  | "Saturday"
  | "Sunday";

/** Time of day, in the scaling plan's time zone. */
export interface ScalingTime {
  /** Hour (0-23). */
  hour: number;
  /** Minute (0-59). */
  minute: number;
}

export type ScalingLoadBalancingAlgorithm = "BreadthFirst" | "DepthFirst";

export interface ScalingPlanPooledScheduleProps {
  /** Resource group of the scaling plan. Changing it replaces the schedule. */
  resourceGroup: string;
  /**
   * Name of a `Pooled` scaling plan. Changing it replaces the schedule.
   */
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
  /** Load balancing during ramp-up. @default "BreadthFirst" */
  rampUpLoadBalancingAlgorithm?: ScalingLoadBalancingAlgorithm;
  /** Minimum percentage of session hosts kept running during ramp-up. */
  rampUpMinimumHostsPct?: number;
  /** Used-capacity percentage that triggers starting more hosts during ramp-up. */
  rampUpCapacityThresholdPct?: number;
  /** Start of the peak phase. */
  peakStartTime: ScalingTime;
  /** Load balancing during peak. @default "DepthFirst" */
  peakLoadBalancingAlgorithm?: ScalingLoadBalancingAlgorithm;
  /** Start of the ramp-down phase. */
  rampDownStartTime: ScalingTime;
  /** Load balancing during ramp-down. @default "DepthFirst" */
  rampDownLoadBalancingAlgorithm?: ScalingLoadBalancingAlgorithm;
  /** Minimum percentage of session hosts kept running during ramp-down. */
  rampDownMinimumHostsPct?: number;
  /** Used-capacity percentage below which hosts are stopped during ramp-down. */
  rampDownCapacityThresholdPct?: number;
  /** Force users to log off when their host is stopped during ramp-down. */
  rampDownForceLogoffUsers?: boolean;
  /** Which sessions block stopping a host during ramp-down. */
  rampDownStopHostsWhen?: "ZeroSessions" | "ZeroActiveSessions";
  /** Minutes users get to save their work before a forced logoff. */
  rampDownWaitTimeMinutes?: number;
  /** Message shown to users before a forced logoff. */
  rampDownNotificationMessage?: string;
  /** Start of the off-peak phase. */
  offPeakStartTime: ScalingTime;
  /** Load balancing during off-peak. @default "DepthFirst" */
  offPeakLoadBalancingAlgorithm?: ScalingLoadBalancingAlgorithm;
}

export interface ScalingPlanPooledSchedule extends Resource<
  "Azure.DesktopVirtualization.ScalingPlanPooledSchedule",
  ScalingPlanPooledScheduleProps,
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
 * A schedule of a `Pooled` Azure Virtual Desktop scaling plan: the
 * ramp-up, peak, ramp-down, and off-peak phases for a set of weekdays.
 *
 * Schedules have no tags; Alchemy treats a schedule as owned when its
 * scaling plan carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/virtual-desktop/autoscale-scaling-plan
 *
 * ### Creating a Schedule
 * **Example:** Weekday schedule
 * ```typescript
 * const weekdays = yield* Azure.DesktopVirtualization.ScalingPlanPooledSchedule(
 *   "weekdays",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     scalingPlan: plan.scalingPlanName,
 *     daysOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
 *     rampUpStartTime: { hour: 7, minute: 0 },
 *     rampUpMinimumHostsPct: 20,
 *     rampUpCapacityThresholdPct: 60,
 *     peakStartTime: { hour: 9, minute: 0 },
 *     rampDownStartTime: { hour: 18, minute: 0 },
 *     rampDownMinimumHostsPct: 10,
 *     rampDownCapacityThresholdPct: 90,
 *     rampDownForceLogoffUsers: false,
 *     rampDownStopHostsWhen: "ZeroSessions",
 *     rampDownWaitTimeMinutes: 30,
 *     rampDownNotificationMessage: "Please save your work.",
 *     offPeakStartTime: { hour: 20, minute: 0 },
 *   },
 * );
 * ```
 *
 * @resource
 */
export const ScalingPlanPooledSchedule = Resource<ScalingPlanPooledSchedule>(
  "Azure.DesktopVirtualization.ScalingPlanPooledSchedule",
);

type ObservedSchedule =
  desktopvirtualization.GetScalingPlanPooledScheduleResponse;

const getSchedule = (
  subscriptionId: string,
  resourceGroupName: string,
  scalingPlanName: string,
  scalingPlanScheduleName: string,
) =>
  orUndefinedIfNotFound(
    desktopvirtualization.GetScalingPlanPooledSchedule({
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
): ScalingPlanPooledSchedule["Attributes"] => ({
  scheduleName: name,
  scheduleId: schedule.id ?? "",
  resourceGroup,
  scalingPlan,
  daysOfWeek: schedule.properties?.daysOfWeek ?? [],
});

const desiredProperties = (news: ScalingPlanPooledScheduleProps) => ({
  daysOfWeek: news.daysOfWeek,
  rampUpStartTime: news.rampUpStartTime,
  rampUpLoadBalancingAlgorithm:
    news.rampUpLoadBalancingAlgorithm ?? "BreadthFirst",
  rampUpMinimumHostsPct: news.rampUpMinimumHostsPct,
  rampUpCapacityThresholdPct: news.rampUpCapacityThresholdPct,
  peakStartTime: news.peakStartTime,
  peakLoadBalancingAlgorithm: news.peakLoadBalancingAlgorithm ?? "DepthFirst",
  rampDownStartTime: news.rampDownStartTime,
  rampDownLoadBalancingAlgorithm:
    news.rampDownLoadBalancingAlgorithm ?? "DepthFirst",
  rampDownMinimumHostsPct: news.rampDownMinimumHostsPct,
  rampDownCapacityThresholdPct: news.rampDownCapacityThresholdPct,
  rampDownForceLogoffUsers: news.rampDownForceLogoffUsers,
  rampDownStopHostsWhen: news.rampDownStopHostsWhen,
  rampDownWaitTimeMinutes: news.rampDownWaitTimeMinutes,
  rampDownNotificationMessage: news.rampDownNotificationMessage,
  offPeakStartTime: news.offPeakStartTime,
  offPeakLoadBalancingAlgorithm:
    news.offPeakLoadBalancingAlgorithm ?? "DepthFirst",
});

export const ScalingPlanPooledScheduleProvider = () =>
  Provider.succeed(ScalingPlanPooledSchedule, {
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
        observed = yield* desktopvirtualization.CreateScalingPlanPooledSchedule(
          { ...request, properties: desired },
        );
      } else {
        // Sync: PATCH only the observed deltas.
        const delta = deltaOf(desired, observed.properties);
        if (delta !== undefined) {
          observed =
            yield* desktopvirtualization.UpdateScalingPlanPooledSchedule({
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
        desktopvirtualization.DeleteScalingPlanPooledSchedule({
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
