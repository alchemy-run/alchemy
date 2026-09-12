import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Cluster } from "./Cluster.ts";
import type { ParameterGroup } from "./ParameterGroup.ts";
import type { SubnetGroup } from "./SubnetGroup.ts";

/**
 * Dashboard UI providers for AWS DAX resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const DAX_COLOR = "#C925D1";

export const ClusterUI = UIProvider.succeed<Cluster>("AWS.DAX.Cluster", {
  displayName: "DAX Cluster",
  icon: "database",
  color: DAX_COLOR,
  category: "database",
  summary: (ctx) => ctx.attrs?.clusterName,
  facts: (ctx) => [
    { label: "cluster", value: ctx.attrs?.clusterName, copy: true },
    { label: "arn", value: ctx.attrs?.clusterArn, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.status },
    { label: "node type", value: ctx.attrs?.nodeType },
    { label: "nodes", value: ctx.attrs?.totalNodes },
    {
      label: "endpoint",
      value: ctx.attrs?.discoveryEndpointUrl,
      mono: true,
      copy: true,
    },
    { label: "encryption", value: ctx.attrs?.clusterEndpointEncryptionType },
  ],
});

export const ParameterGroupUI = UIProvider.succeed<ParameterGroup>(
  "AWS.DAX.ParameterGroup",
  {
    displayName: "DAX Parameter Group",
    icon: "settings",
    color: DAX_COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.parameterGroupName,
    facts: (ctx) => [
      {
        label: "parameter group",
        value: ctx.attrs?.parameterGroupName,
        copy: true,
      },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const SubnetGroupUI = UIProvider.succeed<SubnetGroup>(
  "AWS.DAX.SubnetGroup",
  {
    displayName: "DAX Subnet Group",
    icon: "network",
    color: DAX_COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.subnetGroupName,
    facts: (ctx) => [
      { label: "subnet group", value: ctx.attrs?.subnetGroupName, copy: true },
      { label: "vpc", value: ctx.attrs?.vpcId, mono: true },
      {
        label: "subnets",
        value: ctx.attrs?.subnetIds?.length
          ? ctx.attrs.subnetIds.join(", ")
          : undefined,
        mono: true,
      },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(ClusterUI, ParameterGroupUI, SubnetGroupUI);
