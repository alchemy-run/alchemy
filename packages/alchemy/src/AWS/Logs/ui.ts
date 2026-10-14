import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Destination } from "./Destination.ts";
import type { LogGroup } from "./LogGroup.ts";
import type { LogStream } from "./LogStream.ts";
import type { MetricFilter } from "./MetricFilter.ts";
import type { ResourcePolicy } from "./ResourcePolicy.ts";
import type { SubscriptionFilter } from "./SubscriptionFilter.ts";

/**
 * Dashboard UI providers for AWS Logs (CloudWatch Logs) resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const regionOf = (arn: string | undefined) => arn?.split(":")[3];

export const LogGroupUI = UIProvider.succeed<LogGroup>("AWS.Logs.LogGroup", {
  displayName: "Log Group",
  icon: "scroll-text",
  color: "#E7157B",
  category: "observability",
  summary: (ctx) => ctx.attrs?.logGroupName,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.logGroupArn);
    return ctx.attrs?.logGroupName === undefined || region === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/${encodeURIComponent(encodeURIComponent(ctx.attrs.logGroupName))}`;
  },
  facts: (ctx) => [
    { label: "log group", value: ctx.attrs?.logGroupName, copy: true },
    { label: "arn", value: ctx.attrs?.logGroupArn, mono: true, copy: true },
    {
      label: "retention",
      value:
        ctx.attrs?.retentionInDays === undefined
          ? "never expire"
          : `${ctx.attrs.retentionInDays} days`,
    },
    { label: "class", value: ctx.attrs?.logGroupClass },
    { label: "kms key", value: ctx.attrs?.kmsKeyId, mono: true, copy: true },
    {
      label: "deletion protection",
      value: ctx.attrs?.deletionProtectionEnabled,
    },
  ],
});

export const DestinationUI = UIProvider.succeed<Destination>(
  "AWS.Logs.Destination",
  {
    displayName: "Log Destination",
    icon: "share-2",
    color: "#E7157B",
    category: "observability",
    summary: (ctx) => ctx.attrs?.destinationName,
    facts: (ctx) => [
      { label: "destination", value: ctx.attrs?.destinationName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.destinationArn,
        mono: true,
        copy: true,
      },
      { label: "target", value: ctx.attrs?.targetArn, mono: true },
      { label: "role", value: ctx.attrs?.roleArn, mono: true },
      {
        label: "access policy",
        value: ctx.attrs?.accessPolicy !== undefined,
      },
    ],
  },
);

export const LogStreamUI = UIProvider.succeed<LogStream>("AWS.Logs.LogStream", {
  displayName: "Log Stream",
  icon: "file-text",
  color: "#E7157B",
  category: "observability",
  summary: (ctx) => ctx.attrs?.logStreamName,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.logStreamArn);
    return ctx.attrs?.logGroupName === undefined ||
      ctx.attrs?.logStreamName === undefined ||
      region === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/${encodeURIComponent(encodeURIComponent(ctx.attrs.logGroupName))}/log-events/${encodeURIComponent(encodeURIComponent(ctx.attrs.logStreamName))}`;
  },
  facts: (ctx) => [
    { label: "stream", value: ctx.attrs?.logStreamName, copy: true },
    { label: "log group", value: ctx.attrs?.logGroupName, copy: true },
    { label: "arn", value: ctx.attrs?.logStreamArn, mono: true, copy: true },
  ],
});

export const MetricFilterUI = UIProvider.succeed<MetricFilter>(
  "AWS.Logs.MetricFilter",
  {
    displayName: "Log Metric Filter",
    icon: "filter",
    color: "#E7157B",
    category: "observability",
    summary: (ctx) => ctx.attrs?.filterName,
    facts: (ctx) => [
      { label: "filter", value: ctx.attrs?.filterName, copy: true },
      { label: "log group", value: ctx.attrs?.logGroupName, copy: true },
      { label: "pattern", value: ctx.attrs?.filterPattern, mono: true },
      {
        label: "metric",
        value: ctx.attrs?.metricTransformations?.[0]?.metricName,
      },
      {
        label: "transformations",
        value: ctx.attrs?.metricTransformations?.length,
      },
    ],
  },
);

export const ResourcePolicyUI = UIProvider.succeed<ResourcePolicy>(
  "AWS.Logs.ResourcePolicy",
  {
    displayName: "Log Resource Policy",
    icon: "lock",
    color: "#E7157B",
    category: "security",
    summary: (ctx) => ctx.attrs?.policyName,
    facts: (ctx) => [
      { label: "policy", value: ctx.attrs?.policyName, copy: true },
      {
        label: "document",
        value: ctx.attrs?.policyDocument,
        mono: true,
        copy: true,
      },
      {
        label: "document length",
        value: ctx.attrs?.policyDocument?.length,
      },
    ],
  },
);

export const SubscriptionFilterUI = UIProvider.succeed<SubscriptionFilter>(
  "AWS.Logs.SubscriptionFilter",
  {
    displayName: "Log Subscription Filter",
    icon: "send",
    color: "#E7157B",
    category: "observability",
    summary: (ctx) => ctx.attrs?.filterName,
    facts: (ctx) => [
      { label: "filter", value: ctx.attrs?.filterName, copy: true },
      { label: "log group", value: ctx.attrs?.logGroupName, copy: true },
      {
        label: "destination",
        value: ctx.attrs?.destinationArn,
        mono: true,
        copy: true,
      },
      { label: "pattern", value: ctx.attrs?.filterPattern, mono: true },
      { label: "distribution", value: ctx.attrs?.distribution },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    LogGroupUI,
    DestinationUI,
    LogStreamUI,
    MetricFilterUI,
    ResourcePolicyUI,
    SubscriptionFilterUI,
  );
