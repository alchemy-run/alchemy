import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { LogGroup } from "./LogGroup.ts";

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

export const ui = () => Layer.mergeAll(LogGroupUI);
