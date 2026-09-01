import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AssetDeployment } from "./AssetDeployment.ts";

/**
 * Dashboard UI providers for AWS Website resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */
export const AssetDeploymentUI = UIProvider.succeed<AssetDeployment>(
  "AWS.Website.AssetDeployment",
  {
    displayName: "Website Asset Deployment",
    icon: "upload",
    color: "#FF9900",
    category: "storage",
    summary: (ctx) =>
      ctx.attrs?.bucketName === undefined
        ? undefined
        : ctx.attrs?.prefix
          ? `${ctx.attrs.bucketName}/${ctx.attrs.prefix}`
          : ctx.attrs.bucketName,
    consoleUrl: (ctx) =>
      ctx.attrs?.bucketName === undefined
        ? undefined
        : `https://console.aws.amazon.com/s3/buckets/${ctx.attrs.bucketName}${ctx.attrs.prefix ? `?prefix=${ctx.attrs.prefix}/` : ""}`,
    facts: (ctx) => [
      { label: "bucket", value: ctx.attrs?.bucketName, copy: true },
      { label: "prefix", value: ctx.attrs?.prefix, mono: true },
      { label: "version", value: ctx.attrs?.version, mono: true, copy: true },
      { label: "files", value: ctx.attrs?.fileCount },
    ],
  },
);

export const ui = () => Layer.mergeAll(AssetDeploymentUI);
