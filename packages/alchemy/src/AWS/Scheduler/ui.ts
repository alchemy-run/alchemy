import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Schedule } from "./Schedule.ts";
import type { ScheduleGroup } from "./ScheduleGroup.ts";

/**
 * Dashboard UI providers for AWS EventBridge Scheduler resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const regionOf = (arn: string | undefined) => arn?.split(":")[3];

export const ScheduleUI = UIProvider.succeed<Schedule>(
  "AWS.Scheduler.Schedule",
  {
    displayName: "Scheduler Schedule",
    icon: "timer",
    color: "#E7157B",
    category: "eventing",
    summary: (ctx) => ctx.attrs?.scheduleName,
    consoleUrl: (ctx) => {
      const region = regionOf(ctx.attrs?.scheduleArn);
      return ctx.attrs?.scheduleName === undefined ||
        ctx.attrs?.groupName === undefined ||
        region === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/scheduler/home?region=${region}#schedules/${encodeURIComponent(ctx.attrs.groupName)}/${encodeURIComponent(ctx.attrs.scheduleName)}`;
    },
    facts: (ctx) => [
      { label: "schedule", value: ctx.attrs?.scheduleName, copy: true },
      { label: "arn", value: ctx.attrs?.scheduleArn, mono: true, copy: true },
      { label: "group", value: ctx.attrs?.groupName },
      { label: "expression", value: ctx.props?.scheduleExpression, mono: true },
      { label: "timezone", value: ctx.props?.scheduleExpressionTimezone },
      { label: "state", value: ctx.attrs?.state },
    ],
  },
);

export const ScheduleGroupUI = UIProvider.succeed<ScheduleGroup>(
  "AWS.Scheduler.ScheduleGroup",
  {
    displayName: "Scheduler Schedule Group",
    icon: "folder-clock",
    color: "#E7157B",
    category: "eventing",
    summary: (ctx) => ctx.attrs?.scheduleGroupName,
    facts: (ctx) => [
      { label: "group", value: ctx.attrs?.scheduleGroupName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.scheduleGroupArn,
        mono: true,
        copy: true,
      },
      { label: "state", value: ctx.attrs?.state },
    ],
  },
);

export const ui = () => Layer.mergeAll(ScheduleUI, ScheduleGroupUI);
