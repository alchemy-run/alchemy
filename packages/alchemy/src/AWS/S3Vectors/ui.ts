import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Index } from "./VectorIndex.ts";
import type { VectorBucket } from "./VectorBucket.ts";

/**
 * Dashboard UI providers for AWS S3Vectors resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Storage brand green. */
const COLOR = "#7AA116";

export const VectorBucketUI = UIProvider.succeed<VectorBucket>(
  "AWS.S3Vectors.VectorBucket",
  {
    displayName: "S3 Vector Bucket",
    icon: "cylinder",
    color: COLOR,
    category: "storage",
    summary: (ctx) => ctx.attrs?.vectorBucketName,
    facts: (ctx) => [
      { label: "bucket", value: ctx.attrs?.vectorBucketName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.vectorBucketArn,
        mono: true,
        copy: true,
      },
      { label: "sse type", value: ctx.props?.encryption?.sseType },
    ],
  },
);

export const IndexUI = UIProvider.succeed<Index>("AWS.S3Vectors.Index", {
  displayName: "S3 Vector Index",
  icon: "search",
  color: COLOR,
  category: "storage",
  summary: (ctx) => ctx.attrs?.indexName,
  facts: (ctx) => [
    { label: "index", value: ctx.attrs?.indexName, copy: true },
    { label: "arn", value: ctx.attrs?.indexArn, mono: true, copy: true },
    { label: "bucket", value: ctx.attrs?.vectorBucketName, mono: true },
    { label: "dimension", value: ctx.props?.dimension },
    { label: "distance metric", value: ctx.props?.distanceMetric },
  ],
});

export const ui = () => Layer.mergeAll(VectorBucketUI, IndexUI);
