import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Dataset } from "./Dataset.ts";
import type { DatasetGroup } from "./DatasetGroup.ts";

/**
 * Dashboard UI providers for AWS Forecast resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** Forecast brand color (AWS Machine Learning teal). */
const FORECAST_COLOR = "#01A88D";

export const DatasetUI = UIProvider.succeed<Dataset>("AWS.Forecast.Dataset", {
  displayName: "Forecast Dataset",
  icon: "table",
  color: FORECAST_COLOR,
  category: "ai",
  summary: (ctx) => ctx.attrs?.datasetName,
  facts: (ctx) => [
    { label: "dataset", value: ctx.attrs?.datasetName, copy: true },
    { label: "arn", value: ctx.attrs?.datasetArn, mono: true, copy: true },
    { label: "domain", value: ctx.attrs?.domain },
    { label: "type", value: ctx.attrs?.datasetType },
    { label: "status", value: ctx.attrs?.status },
  ],
});

export const DatasetGroupUI = UIProvider.succeed<DatasetGroup>(
  "AWS.Forecast.DatasetGroup",
  {
    displayName: "Forecast Dataset Group",
    icon: "boxes",
    color: FORECAST_COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.datasetGroupName,
    facts: (ctx) => [
      { label: "group", value: ctx.attrs?.datasetGroupName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.datasetGroupArn,
        mono: true,
        copy: true,
      },
      { label: "domain", value: ctx.attrs?.domain },
      { label: "status", value: ctx.attrs?.status },
      { label: "datasets", value: ctx.props?.datasetArns?.length },
    ],
  },
);

export const ui = () => Layer.mergeAll(DatasetUI, DatasetGroupUI);
