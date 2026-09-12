import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { EventSourcesConfig } from "./EventSourcesConfig.ts";
import type { NotificationChannel } from "./NotificationChannel.ts";
import type { ResourceCollection } from "./ResourceCollection.ts";
import type { ServiceIntegration } from "./ServiceIntegration.ts";

/**
 * Dashboard UI providers for AWS DevOpsGuru resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const COLOR = "#E7157B";

export const EventSourcesConfigUI = UIProvider.succeed<EventSourcesConfig>(
  "AWS.DevOpsGuru.EventSourcesConfig",
  {
    displayName: "DevOps Guru Event Sources",
    icon: "plug-zap",
    color: COLOR,
    category: "observability",
    summary: (ctx) =>
      ctx.attrs?.amazonCodeGuruProfiler ? "CodeGuru Profiler" : undefined,
    facts: (ctx) => [
      {
        label: "codeguru profiler",
        value: ctx.attrs?.amazonCodeGuruProfiler,
      },
    ],
  },
);

export const NotificationChannelUI = UIProvider.succeed<NotificationChannel>(
  "AWS.DevOpsGuru.NotificationChannel",
  {
    displayName: "DevOps Guru Notification Channel",
    icon: "bell",
    color: COLOR,
    category: "observability",
    summary: (ctx) => ctx.attrs?.topicArn,
    facts: (ctx) => [
      { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
      {
        label: "topic",
        value: ctx.attrs?.topicArn,
        mono: true,
        copy: true,
      },
      {
        label: "severities",
        value: ctx.props?.severities?.length
          ? ctx.props.severities.join(", ")
          : undefined,
      },
    ],
  },
);

export const ResourceCollectionUI = UIProvider.succeed<ResourceCollection>(
  "AWS.DevOpsGuru.ResourceCollection",
  {
    displayName: "DevOps Guru Resource Collection",
    icon: "boxes",
    color: COLOR,
    category: "observability",
    summary: (ctx) =>
      ctx.attrs?.cloudFormationStackNames?.length
        ? ctx.attrs.cloudFormationStackNames.join(", ")
        : ctx.attrs?.tags?.map((t) => t.appBoundaryKey).join(", "),
    facts: (ctx) => [
      {
        label: "stacks",
        value: ctx.attrs?.cloudFormationStackNames?.length
          ? ctx.attrs.cloudFormationStackNames.join(", ")
          : undefined,
      },
      {
        label: "tag keys",
        value: ctx.attrs?.tags?.length
          ? ctx.attrs.tags.map((t) => t.appBoundaryKey).join(", ")
          : undefined,
      },
    ],
  },
);

export const ServiceIntegrationUI = UIProvider.succeed<ServiceIntegration>(
  "AWS.DevOpsGuru.ServiceIntegration",
  {
    displayName: "DevOps Guru Service Integration",
    icon: "plug",
    color: COLOR,
    category: "observability",
    summary: (ctx) => ctx.attrs?.encryptionType,
    facts: (ctx) => [
      { label: "ops center", value: ctx.attrs?.opsCenter },
      {
        label: "logs anomaly detection",
        value: ctx.attrs?.logsAnomalyDetection,
      },
      { label: "encryption", value: ctx.attrs?.encryptionType },
      { label: "kms key", value: ctx.attrs?.kmsKeyId, mono: true },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    EventSourcesConfigUI,
    NotificationChannelUI,
    ResourceCollectionUI,
    ServiceIntegrationUI,
  );
