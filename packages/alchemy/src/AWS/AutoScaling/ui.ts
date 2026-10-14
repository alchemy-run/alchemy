import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AutoScalingGroup } from "./AutoScalingGroup.ts";
import type { LaunchTemplate } from "./LaunchTemplate.ts";
import type { LifecycleHook } from "./LifecycleHook.ts";
import type { ScalingPolicy } from "./ScalingPolicy.ts";
import type { ScheduledAction } from "./ScheduledAction.ts";

/**
 * Dashboard UI providers for AWS AutoScaling resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS compute brand orange. */
const COMPUTE_ORANGE = "#ED7100";

/** Extract the region segment from an AWS ARN (arn:aws:svc:REGION:...). */
const regionOfArn = (arn: string | undefined): string | undefined =>
  arn?.split(":")[3] || undefined;

export const AutoScalingGroupUI = UIProvider.succeed<AutoScalingGroup>(
  "AWS.AutoScaling.AutoScalingGroup",
  {
    displayName: "Auto Scaling Group",
    icon: "scaling",
    color: COMPUTE_ORANGE,
    category: "compute",
    summary: (ctx) => ctx.attrs?.autoScalingGroupName,
    consoleUrl: (ctx) => {
      const region = regionOfArn(ctx.attrs?.autoScalingGroupArn);
      return ctx.attrs?.autoScalingGroupName === undefined ||
        region === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#AutoScalingGroupDetails:id=${encodeURIComponent(ctx.attrs.autoScalingGroupName)};view=details`;
    },
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.autoScalingGroupName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.autoScalingGroupArn,
        mono: true,
        copy: true,
      },
      {
        label: "capacity",
        value:
          ctx.attrs?.desiredCapacity === undefined
            ? undefined
            : `${ctx.attrs.minSize} / ${ctx.attrs.desiredCapacity} / ${ctx.attrs.maxSize} (min/desired/max)`,
      },
      {
        label: "launch template",
        value: ctx.attrs?.launchTemplateName ?? ctx.attrs?.launchTemplateId,
        mono: true,
      },
      { label: "health check", value: ctx.attrs?.healthCheckType },
      { label: "subnets", value: ctx.attrs?.subnetIds?.length },
      { label: "target groups", value: ctx.attrs?.targetGroupArns?.length },
    ],
  },
);

export const LaunchTemplateUI = UIProvider.succeed<LaunchTemplate>(
  "AWS.AutoScaling.LaunchTemplate",
  {
    displayName: "Launch Template",
    icon: "rocket",
    color: COMPUTE_ORANGE,
    category: "compute",
    summary: (ctx) => ctx.attrs?.launchTemplateName,
    consoleUrl: (ctx) => {
      const region = regionOfArn(ctx.attrs?.launchTemplateArn);
      return ctx.attrs?.launchTemplateId === undefined || region === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#LaunchTemplateDetails:launchTemplateId=${ctx.attrs.launchTemplateId}`;
    },
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.launchTemplateName, copy: true },
      {
        label: "template id",
        value: ctx.attrs?.launchTemplateId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.launchTemplateArn,
        mono: true,
        copy: true,
      },
      { label: "latest version", value: ctx.attrs?.latestVersionNumber },
      { label: "default version", value: ctx.attrs?.defaultVersionNumber },
      { label: "instance type", value: ctx.props?.instanceType },
      { label: "ami", value: ctx.props?.imageId, mono: true },
    ],
  },
);

export const ScalingPolicyUI = UIProvider.succeed<ScalingPolicy>(
  "AWS.AutoScaling.ScalingPolicy",
  {
    displayName: "Scaling Policy",
    icon: "gauge",
    color: COMPUTE_ORANGE,
    category: "compute",
    summary: (ctx) => ctx.attrs?.policyName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.policyName, copy: true },
      { label: "arn", value: ctx.attrs?.policyArn, mono: true, copy: true },
      { label: "auto scaling group", value: ctx.attrs?.autoScalingGroupName },
      { label: "type", value: ctx.attrs?.policyType },
      { label: "metric", value: ctx.attrs?.predefinedMetricType },
      { label: "target value", value: ctx.attrs?.targetValue },
      { label: "alarms", value: ctx.attrs?.alarms?.length },
    ],
  },
);

export const LifecycleHookUI = UIProvider.succeed<LifecycleHook>(
  "AWS.AutoScaling.LifecycleHook",
  {
    displayName: "Lifecycle Hook",
    icon: "timer",
    color: COMPUTE_ORANGE,
    category: "compute",
    summary: (ctx) => ctx.attrs?.lifecycleHookName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.lifecycleHookName, copy: true },
      { label: "auto scaling group", value: ctx.attrs?.autoScalingGroupName },
      { label: "transition", value: ctx.attrs?.lifecycleTransition },
      { label: "heartbeat timeout (s)", value: ctx.attrs?.heartbeatTimeout },
      { label: "default result", value: ctx.attrs?.defaultResult },
      {
        label: "notification target",
        value: ctx.attrs?.notificationTargetARN,
        mono: true,
      },
    ],
  },
);

export const ScheduledActionUI = UIProvider.succeed<ScheduledAction>(
  "AWS.AutoScaling.ScheduledAction",
  {
    displayName: "Scheduled Action",
    icon: "calendar",
    color: COMPUTE_ORANGE,
    category: "compute",
    summary: (ctx) => ctx.attrs?.scheduledActionName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.scheduledActionName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.scheduledActionARN,
        mono: true,
        copy: true,
      },
      { label: "auto scaling group", value: ctx.attrs?.autoScalingGroupName },
      { label: "recurrence", value: ctx.attrs?.recurrence, mono: true },
      { label: "start time", value: ctx.attrs?.startTime },
      {
        label: "capacity",
        value:
          ctx.attrs?.desiredCapacity === undefined
            ? undefined
            : `${ctx.attrs.minSize ?? ""} / ${ctx.attrs.desiredCapacity} / ${ctx.attrs.maxSize ?? ""} (min/desired/max)`,
      },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    AutoScalingGroupUI,
    LaunchTemplateUI,
    ScalingPolicyUI,
    LifecycleHookUI,
    ScheduledActionUI,
  );
