import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Export } from "./Export.ts";

/**
 * Dashboard UI providers for AWS BCMDataExports resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const ExportUI = UIProvider.succeed<Export>(
  "AWS.BCMDataExports.Export",
  {
    displayName: "Data Export",
    icon: "download",
    color: "#E7157B",
    category: "billing",
    summary: (ctx) => ctx.attrs?.exportName,
    facts: (ctx) => [
      { label: "export", value: ctx.attrs?.exportName, copy: true },
      { label: "arn", value: ctx.attrs?.exportArn, mono: true, copy: true },
      {
        label: "bucket",
        value: ctx.props?.s3Destination?.s3Bucket,
        mono: true,
      },
      {
        label: "prefix",
        value: ctx.props?.s3Destination?.s3Prefix,
        mono: true,
      },
      { label: "refresh", value: ctx.props?.refreshCadence?.frequency },
      { label: "description", value: ctx.props?.description },
    ],
  },
);

export const ui = () => Layer.mergeAll(ExportUI);
