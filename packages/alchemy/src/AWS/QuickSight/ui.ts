import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Analysis } from "./Analysis.ts";
import type { Dashboard } from "./Dashboard.ts";
import type { DataSet } from "./DataSet.ts";
import type { DataSource } from "./DataSource.ts";

/**
 * Dashboard UI providers for AWS QuickSight resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const COLOR = "#8C4FFF";

export const DataSourceUI = UIProvider.succeed<DataSource>(
  "AWS.QuickSight.DataSource",
  {
    displayName: "QuickSight Data Source",
    icon: "database",
    color: COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "data source", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.dataSourceId, mono: true, copy: true },
      { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
      { label: "type", value: ctx.attrs?.type },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const DataSetUI = UIProvider.succeed<DataSet>("AWS.QuickSight.DataSet", {
  displayName: "QuickSight Dataset",
  icon: "table",
  color: COLOR,
  category: "database",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "dataset", value: ctx.attrs?.name, copy: true },
    { label: "id", value: ctx.attrs?.dataSetId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
    { label: "import mode", value: ctx.props?.importMode },
  ],
});

export const AnalysisUI = UIProvider.succeed<Analysis>(
  "AWS.QuickSight.Analysis",
  {
    displayName: "QuickSight Analysis",
    icon: "chart-bar",
    color: COLOR,
    category: "other",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "analysis", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.analysisId, mono: true, copy: true },
      { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const DashboardUI = UIProvider.succeed<Dashboard>(
  "AWS.QuickSight.Dashboard",
  {
    displayName: "QuickSight Dashboard",
    icon: "chart-line",
    color: COLOR,
    category: "other",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "dashboard", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.dashboardId, mono: true, copy: true },
      { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(DataSourceUI, DataSetUI, AnalysisUI, DashboardUI);
