import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AppMonitor } from "./AppMonitor.ts";
import type { MetricsDestination } from "./MetricsDestination.ts";
import type { ResourcePolicy } from "./ResourcePolicy.ts";

/**
 * Dashboard UI providers for AWS RUM resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS management & governance / observability brand pink. */
const COLOR = "#E7157B";

export const AppMonitorUI = UIProvider.succeed<AppMonitor>(
  "AWS.RUM.AppMonitor",
  {
    displayName: "RUM App Monitor",
    icon: "activity",
    color: COLOR,
    category: "observability",
    summary: (ctx) => ctx.attrs?.appMonitorName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.appMonitorName, copy: true },
      { label: "id", value: ctx.attrs?.appMonitorId, mono: true, copy: true },
      { label: "arn", value: ctx.attrs?.appMonitorArn, mono: true, copy: true },
      { label: "domain", value: ctx.props?.domain },
    ],
  },
);

export const MetricsDestinationUI = UIProvider.succeed<MetricsDestination>(
  "AWS.RUM.MetricsDestination",
  {
    displayName: "RUM Metrics Destination",
    icon: "chart-line",
    color: COLOR,
    category: "observability",
    summary: (ctx) => ctx.attrs?.destination,
    facts: (ctx) => [
      { label: "app monitor", value: ctx.attrs?.appMonitorName, copy: true },
      { label: "destination", value: ctx.attrs?.destination },
      {
        label: "destination arn",
        value: ctx.attrs?.destinationArn,
        mono: true,
      },
      { label: "iam role", value: ctx.attrs?.iamRoleArn, mono: true },
    ],
  },
);

export const ResourcePolicyUI = UIProvider.succeed<ResourcePolicy>(
  "AWS.RUM.ResourcePolicy",
  {
    displayName: "RUM Resource Policy",
    icon: "lock",
    color: COLOR,
    category: "observability",
    summary: (ctx) => ctx.attrs?.appMonitorName,
    facts: (ctx) => [
      { label: "app monitor", value: ctx.attrs?.appMonitorName, copy: true },
      { label: "revision", value: ctx.attrs?.policyRevisionId, mono: true },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(AppMonitorUI, MetricsDestinationUI, ResourcePolicyUI);
