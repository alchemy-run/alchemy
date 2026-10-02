import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Monitor } from "./Monitor.ts";

/**
 * Dashboard UI providers for AWS InternetMonitor resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const MonitorUI = UIProvider.succeed<Monitor>(
  "AWS.InternetMonitor.Monitor",
  {
    displayName: "Internet Monitor",
    icon: "globe",
    color: "#E7157B",
    category: "observability",
    summary: (ctx) => ctx.attrs?.monitorName,
    facts: (ctx) => [
      { label: "monitor", value: ctx.attrs?.monitorName, copy: true },
      { label: "arn", value: ctx.attrs?.monitorArn, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.status },
      { label: "processing", value: ctx.attrs?.processingStatus },
      {
        label: "resources",
        value: ctx.attrs?.resources?.length
          ? ctx.attrs.resources.join(", ")
          : undefined,
        mono: true,
      },
      {
        label: "max city networks",
        value: ctx.attrs?.maxCityNetworksToMonitor,
      },
      {
        label: "traffic %",
        value: ctx.attrs?.trafficPercentageToMonitor,
      },
    ],
  },
);

export const ui = () => Layer.mergeAll(MonitorUI);
