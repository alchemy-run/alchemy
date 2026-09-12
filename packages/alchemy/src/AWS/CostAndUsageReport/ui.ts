import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ReportDefinition } from "./ReportDefinition.ts";

/**
 * Dashboard UI providers for AWS CostAndUsageReport resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const ReportDefinitionUI = UIProvider.succeed<ReportDefinition>(
  "AWS.CostAndUsageReport.ReportDefinition",
  {
    displayName: "Cost and Usage Report",
    icon: "dollar-sign",
    color: "#E7157B",
    category: "billing",
    summary: (ctx) => ctx.attrs?.reportName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.reportName, copy: true },
      { label: "arn", value: ctx.attrs?.reportArn, mono: true, copy: true },
      { label: "time unit", value: ctx.attrs?.timeUnit },
      { label: "format", value: ctx.attrs?.format },
      { label: "compression", value: ctx.attrs?.compression },
      { label: "bucket", value: ctx.attrs?.s3Bucket, mono: true, copy: true },
      { label: "prefix", value: ctx.attrs?.s3Prefix, mono: true },
    ],
  },
);

export const ui = () => Layer.mergeAll(ReportDefinitionUI);
