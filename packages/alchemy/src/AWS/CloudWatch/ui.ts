import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Alarm } from "./Alarm.ts";
import type { AlarmMuteRule } from "./AlarmMuteRule.ts";
import type { AnomalyDetector } from "./AnomalyDetector.ts";
import type { CompositeAlarm } from "./CompositeAlarm.ts";
import type { Dashboard } from "./Dashboard.ts";
import type { InsightRule } from "./InsightRule.ts";
import type { MetricStream } from "./MetricStream.ts";

/**
 * Dashboard UI providers for AWS CloudWatch resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const regionOf = (arn: string | undefined) => arn?.split(":")[3];

export const AlarmUI = UIProvider.succeed<Alarm>("AWS.CloudWatch.Alarm", {
  displayName: "CloudWatch Alarm",
  icon: "bell",
  color: "#E7157B",
  category: "observability",
  summary: (ctx) => ctx.attrs?.alarmName,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.alarmArn);
    return ctx.attrs?.alarmName === undefined || region === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#alarmsV2:alarm/${encodeURIComponent(ctx.attrs.alarmName)}`;
  },
  facts: (ctx) => [
    { label: "alarm", value: ctx.attrs?.alarmName, copy: true },
    { label: "arn", value: ctx.attrs?.alarmArn, mono: true, copy: true },
    { label: "state", value: ctx.attrs?.stateValue },
    { label: "namespace", value: ctx.props?.Namespace },
    { label: "metric", value: ctx.props?.MetricName },
    { label: "reason", value: ctx.attrs?.stateReason },
  ],
});

export const CompositeAlarmUI = UIProvider.succeed<CompositeAlarm>(
  "AWS.CloudWatch.CompositeAlarm",
  {
    displayName: "CloudWatch Composite Alarm",
    icon: "bell-plus",
    color: "#E7157B",
    category: "observability",
    summary: (ctx) => ctx.attrs?.alarmName,
    consoleUrl: (ctx) => {
      const region = regionOf(ctx.attrs?.alarmArn);
      return ctx.attrs?.alarmName === undefined || region === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#alarmsV2:alarm/${encodeURIComponent(ctx.attrs.alarmName)}`;
    },
    facts: (ctx) => [
      { label: "alarm", value: ctx.attrs?.alarmName, copy: true },
      { label: "arn", value: ctx.attrs?.alarmArn, mono: true, copy: true },
      { label: "state", value: ctx.attrs?.stateValue },
      { label: "rule", value: ctx.props?.AlarmRule, mono: true },
      { label: "reason", value: ctx.attrs?.stateReason },
    ],
  },
);

export const AlarmMuteRuleUI = UIProvider.succeed<AlarmMuteRule>(
  "AWS.CloudWatch.AlarmMuteRule",
  {
    displayName: "CloudWatch Alarm Mute Rule",
    icon: "bell-off",
    color: "#E7157B",
    category: "observability",
    summary: (ctx) => ctx.attrs?.alarmMuteRuleName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.alarmMuteRuleName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.alarmMuteRuleArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      { label: "mute type", value: ctx.attrs?.muteType },
    ],
  },
);

export const AnomalyDetectorUI = UIProvider.succeed<AnomalyDetector>(
  "AWS.CloudWatch.AnomalyDetector",
  {
    displayName: "CloudWatch Anomaly Detector",
    icon: "activity",
    color: "#E7157B",
    category: "observability",
    summary: (ctx) =>
      ctx.props?.MetricName
        ? `${ctx.props?.Namespace ? `${ctx.props.Namespace}/` : ""}${ctx.props.MetricName}`
        : ctx.attrs?.detectorId,
    facts: (ctx) => [
      { label: "detector id", value: ctx.attrs?.detectorId, mono: true },
      { label: "namespace", value: ctx.props?.Namespace },
      { label: "metric", value: ctx.props?.MetricName },
      { label: "stat", value: ctx.props?.Stat },
    ],
  },
);

export const DashboardUI = UIProvider.succeed<Dashboard>(
  "AWS.CloudWatch.Dashboard",
  {
    displayName: "CloudWatch Dashboard",
    icon: "layout-dashboard",
    color: "#E7157B",
    category: "observability",
    summary: (ctx) => ctx.attrs?.dashboardName,
    consoleUrl: (ctx) => {
      const region = regionOf(ctx.attrs?.dashboardArn);
      return ctx.attrs?.dashboardName === undefined || region === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#dashboards:name=${encodeURIComponent(ctx.attrs.dashboardName)}`;
    },
    facts: (ctx) => [
      { label: "dashboard", value: ctx.attrs?.dashboardName, copy: true },
      { label: "arn", value: ctx.attrs?.dashboardArn, mono: true, copy: true },
      {
        label: "widgets",
        value: Array.isArray((ctx.attrs?.dashboardBody as any)?.widgets)
          ? (ctx.attrs?.dashboardBody as any).widgets.length
          : undefined,
      },
    ],
  },
);

export const InsightRuleUI = UIProvider.succeed<InsightRule>(
  "AWS.CloudWatch.InsightRule",
  {
    displayName: "CloudWatch Insight Rule",
    icon: "trending-up",
    color: "#E7157B",
    category: "observability",
    summary: (ctx) => ctx.attrs?.ruleName,
    facts: (ctx) => [
      { label: "rule", value: ctx.attrs?.ruleName, copy: true },
      { label: "arn", value: ctx.attrs?.ruleArn, mono: true, copy: true },
      { label: "state", value: ctx.attrs?.state },
    ],
  },
);

export const MetricStreamUI = UIProvider.succeed<MetricStream>(
  "AWS.CloudWatch.MetricStream",
  {
    displayName: "CloudWatch Metric Stream",
    icon: "waves",
    color: "#E7157B",
    category: "observability",
    summary: (ctx) => ctx.attrs?.metricStreamName,
    facts: (ctx) => [
      { label: "stream", value: ctx.attrs?.metricStreamName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.metricStreamArn,
        mono: true,
        copy: true,
      },
      { label: "state", value: ctx.attrs?.state },
      { label: "output format", value: ctx.props?.OutputFormat },
      {
        label: "firehose",
        value: ctx.props?.FirehoseArn,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    AlarmUI,
    CompositeAlarmUI,
    AlarmMuteRuleUI,
    AnomalyDetectorUI,
    DashboardUI,
    InsightRuleUI,
    MetricStreamUI,
  );
