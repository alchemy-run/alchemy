import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Application } from "./Application.ts";
import type { ApplicationCloudWatchLoggingOption } from "./ApplicationCloudWatchLoggingOption.ts";
import type { ApplicationSnapshot } from "./ApplicationSnapshot.ts";

/**
 * Dashboard UI providers for AWS KinesisAnalyticsV2 resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const ApplicationUI = UIProvider.succeed<Application>(
  "AWS.KinesisAnalyticsV2.Application",
  {
    displayName: "Managed Flink Application",
    icon: "activity",
    color: "#8C4FFF",
    category: "other",
    summary: (ctx) => ctx.attrs?.applicationName,
    facts: (ctx) => [
      { label: "application", value: ctx.attrs?.applicationName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.applicationArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.applicationStatus },
      { label: "runtime", value: ctx.attrs?.runtimeEnvironment },
      { label: "mode", value: ctx.attrs?.applicationMode },
      { label: "version", value: ctx.attrs?.applicationVersionId },
      { label: "role", value: ctx.attrs?.serviceExecutionRole, mono: true },
    ],
  },
);

export const ApplicationCloudWatchLoggingOptionUI =
  UIProvider.succeed<ApplicationCloudWatchLoggingOption>(
    "AWS.KinesisAnalyticsV2.ApplicationCloudWatchLoggingOption",
    {
      displayName: "Kinesis Analytics Logging Option",
      icon: "scroll-text",
      color: "#8C4FFF",
      category: "observability",
      summary: (ctx) => ctx.attrs?.logStreamArn,
      facts: (ctx) => [
        { label: "application", value: ctx.attrs?.applicationName },
        {
          label: "log stream",
          value: ctx.attrs?.logStreamArn,
          mono: true,
          copy: true,
        },
        {
          label: "option id",
          value: ctx.attrs?.cloudWatchLoggingOptionId,
          mono: true,
        },
      ],
    },
  );

export const ApplicationSnapshotUI = UIProvider.succeed<ApplicationSnapshot>(
  "AWS.KinesisAnalyticsV2.ApplicationSnapshot",
  {
    displayName: "Kinesis Analytics Snapshot",
    icon: "camera",
    color: "#8C4FFF",
    category: "other",
    summary: (ctx) => ctx.attrs?.snapshotName,
    facts: (ctx) => [
      { label: "snapshot", value: ctx.attrs?.snapshotName, copy: true },
      { label: "application", value: ctx.attrs?.applicationName },
      { label: "status", value: ctx.attrs?.snapshotStatus },
      { label: "app version", value: ctx.attrs?.applicationVersionId },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    ApplicationUI,
    ApplicationCloudWatchLoggingOptionUI,
    ApplicationSnapshotUI,
  );
