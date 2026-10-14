import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Cluster } from "./Cluster.ts";
import type { ClusterPolicy } from "./ClusterPolicy.ts";
import type { Stream } from "./Stream.ts";

/**
 * Dashboard UI providers for AWS DSQL resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const ClusterUI = UIProvider.succeed<Cluster>("AWS.DSQL.Cluster", {
  displayName: "Aurora DSQL Cluster",
  icon: "database",
  color: "#C925D1",
  category: "database",
  summary: (ctx) => ctx.attrs?.clusterId,
  facts: (ctx) => [
    { label: "cluster", value: ctx.attrs?.clusterId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.clusterArn, mono: true, copy: true },
    { label: "endpoint", value: ctx.attrs?.endpoint, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.status },
    {
      label: "deletion protection",
      value: ctx.attrs?.deletionProtectionEnabled,
    },
  ],
});

export const ClusterPolicyUI = UIProvider.succeed<ClusterPolicy>(
  "AWS.DSQL.ClusterPolicy",
  {
    displayName: "DSQL Cluster Policy",
    icon: "lock",
    color: "#C925D1",
    category: "security",
    summary: (ctx) => ctx.attrs?.clusterId,
    facts: (ctx) => [
      { label: "cluster", value: ctx.attrs?.clusterId, mono: true },
      { label: "version", value: ctx.attrs?.policyVersion, mono: true },
      { label: "policy", value: ctx.attrs?.policy, mono: true },
    ],
  },
);

export const StreamUI = UIProvider.succeed<Stream>("AWS.DSQL.Stream", {
  displayName: "DSQL Stream",
  icon: "waypoints",
  color: "#C925D1",
  category: "eventing",
  summary: (ctx) => ctx.attrs?.streamId,
  facts: (ctx) => [
    { label: "stream", value: ctx.attrs?.streamId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.streamArn, mono: true, copy: true },
    { label: "cluster", value: ctx.attrs?.clusterId, mono: true },
    { label: "status", value: ctx.attrs?.status },
    { label: "ordering", value: ctx.attrs?.ordering },
    { label: "format", value: ctx.attrs?.format },
    {
      label: "kinesis stream",
      value: ctx.attrs?.kinesisStreamArn,
      mono: true,
    },
  ],
});

export const ui = () => Layer.mergeAll(ClusterUI, ClusterPolicyUI, StreamUI);
