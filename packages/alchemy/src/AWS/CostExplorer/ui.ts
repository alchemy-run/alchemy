import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AnomalyMonitor } from "./AnomalyMonitor.ts";
import type { AnomalySubscription } from "./AnomalySubscription.ts";
import type { CostCategory } from "./CostCategory.ts";

/**
 * Dashboard UI providers for AWS Cost Explorer resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const AnomalyMonitorUI = UIProvider.succeed<AnomalyMonitor>(
  "AWS.CostExplorer.AnomalyMonitor",
  {
    displayName: "Cost Anomaly Monitor",
    icon: "eye",
    color: "#E7157B",
    category: "billing",
    summary: (ctx) => ctx.attrs?.monitorName,
    facts: (ctx) => [
      { label: "monitor", value: ctx.attrs?.monitorName, copy: true },
      { label: "arn", value: ctx.attrs?.monitorArn, mono: true, copy: true },
      { label: "type", value: ctx.attrs?.monitorType },
      { label: "dimension", value: ctx.props?.monitorDimension },
    ],
  },
);

export const AnomalySubscriptionUI = UIProvider.succeed<AnomalySubscription>(
  "AWS.CostExplorer.AnomalySubscription",
  {
    displayName: "Cost Anomaly Subscription",
    icon: "bell",
    color: "#E7157B",
    category: "billing",
    summary: (ctx) => ctx.attrs?.subscriptionName,
    facts: (ctx) => [
      { label: "subscription", value: ctx.attrs?.subscriptionName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.subscriptionArn,
        mono: true,
        copy: true,
      },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
      { label: "frequency", value: ctx.props?.frequency },
      { label: "monitors", value: ctx.props?.monitorArnList?.length },
    ],
  },
);

export const CostCategoryUI = UIProvider.succeed<CostCategory>(
  "AWS.CostExplorer.CostCategory",
  {
    displayName: "Cost Category",
    icon: "tags",
    color: "#E7157B",
    category: "billing",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.costCategoryArn,
        mono: true,
        copy: true,
      },
      { label: "effective start", value: ctx.attrs?.effectiveStart },
      { label: "rules", value: ctx.props?.rules?.length },
      { label: "default value", value: ctx.props?.defaultValue },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(AnomalyMonitorUI, AnomalySubscriptionUI, CostCategoryUI);
