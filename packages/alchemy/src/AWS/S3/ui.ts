import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Bucket } from "./Bucket.ts";

/**
 * Dashboard UI providers for AWS S3 resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */
export const BucketUI = UIProvider.succeed<Bucket>("AWS.S3.Bucket", {
  displayName: "S3 Bucket",
  icon: "cylinder",
  color: "#7AA116",
  category: "storage",
  summary: (ctx) => ctx.attrs?.bucketName,
  consoleUrl: (ctx) =>
    ctx.attrs?.bucketName === undefined
      ? undefined
      : `https://console.aws.amazon.com/s3/buckets/${ctx.attrs.bucketName}${ctx.attrs.region ? `?region=${ctx.attrs.region}` : ""}`,
  facts: (ctx) => [
    { label: "bucket", value: ctx.attrs?.bucketName, copy: true },
    { label: "arn", value: ctx.attrs?.bucketArn, mono: true, copy: true },
    { label: "region", value: ctx.attrs?.region },
    {
      label: "domain",
      value: ctx.attrs?.bucketDomainName,
      href:
        ctx.attrs?.bucketDomainName === undefined
          ? undefined
          : `https://${ctx.attrs.bucketDomainName}`,
    },
  ],
});

export const ui = () => Layer.mergeAll(BucketUI);
