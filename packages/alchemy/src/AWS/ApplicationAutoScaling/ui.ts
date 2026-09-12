import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ScalableTarget } from "./ScalableTarget.ts";
import type { ScalingPolicy } from "./ScalingPolicy.ts";
import type { ScheduledAction } from "./ScheduledAction.ts";

/**
 * Dashboard UI providers for AWS ApplicationAutoScaling resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const ScalableTargetUI = UIProvider.succeed<ScalableTarget>(
  "AWS.ApplicationAutoScaling.ScalableTarget",
  {
    displayName: "Scalable Target",
    icon: "gauge",
    color: "#E7157B",
    category: "config",
    summary: (ctx) => ctx.attrs?.resourceId,
    facts: (ctx) => [
      { label: "namespace", value: ctx.attrs?.serviceNamespace },
      { label: "resource", value: ctx.attrs?.resourceId, copy: true },
      { label: "dimension", value: ctx.attrs?.scalableDimension },
      { label: "min capacity", value: ctx.attrs?.minCapacity },
      { label: "max capacity", value: ctx.attrs?.maxCapacity },
      { label: "role", value: ctx.attrs?.roleArn, mono: true },
      {
        label: "suspended",
        value: ctx.attrs?.suspendedState !== undefined,
      },
    ],
  },
);

export const ScalingPolicyUI = UIProvider.succeed<ScalingPolicy>(
  "AWS.ApplicationAutoScaling.ScalingPolicy",
  {
    displayName: "Auto Scaling Policy",
    icon: "chart-line",
    color: "#E7157B",
    category: "config",
    summary: (ctx) => ctx.attrs?.policyName,
    facts: (ctx) => [
      { label: "policy", value: ctx.attrs?.policyName, copy: true },
      { label: "arn", value: ctx.attrs?.policyArn, mono: true, copy: true },
      { label: "namespace", value: ctx.attrs?.serviceNamespace },
      { label: "resource", value: ctx.attrs?.resourceId },
      { label: "type", value: ctx.attrs?.policyType },
      { label: "alarms", value: ctx.attrs?.alarms?.length },
    ],
  },
);

export const ScheduledActionUI = UIProvider.succeed<ScheduledAction>(
  "AWS.ApplicationAutoScaling.ScheduledAction",
  {
    displayName: "Auto Scaling Scheduled Action",
    icon: "calendar",
    color: "#E7157B",
    category: "config",
    summary: (ctx) => ctx.attrs?.scheduledActionName,
    facts: (ctx) => [
      {
        label: "action",
        value: ctx.attrs?.scheduledActionName,
        copy: true,
      },
      { label: "resource", value: ctx.attrs?.resourceId },
      { label: "schedule", value: ctx.attrs?.schedule, mono: true },
      { label: "timezone", value: ctx.attrs?.timezone },
      {
        label: "min capacity",
        value: ctx.attrs?.scalableTargetAction?.MinCapacity,
      },
      {
        label: "max capacity",
        value: ctx.attrs?.scalableTargetAction?.MaxCapacity,
      },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(ScalableTargetUI, ScalingPolicyUI, ScheduledActionUI);
