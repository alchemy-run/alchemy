import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Dashboard UI providers for AWS DocDBElastic resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const ClusterUI = UIProvider.succeed<Cluster>(
  "AWS.DocDBElastic.Cluster",
  {
    displayName: "DocumentDB Elastic Cluster",
    icon: "database",
    color: "#C925D1",
    category: "database",
    summary: (ctx) => ctx.attrs?.clusterName,
    facts: (ctx) => [
      { label: "cluster", value: ctx.attrs?.clusterName, copy: true },
      { label: "arn", value: ctx.attrs?.clusterArn, mono: true, copy: true },
      {
        label: "endpoint",
        value: ctx.attrs?.clusterEndpoint,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      { label: "admin user", value: ctx.attrs?.adminUserName, mono: true },
      { label: "shard capacity", value: ctx.attrs?.shardCapacity },
      { label: "shard count", value: ctx.attrs?.shardCount },
    ],
  },
);

export const ui = () => Layer.mergeAll(ClusterUI);
