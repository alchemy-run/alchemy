import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Endpoint } from "./Endpoint.ts";
import type { ReplicationInstance } from "./ReplicationInstance.ts";
import type { ReplicationSubnetGroup } from "./ReplicationSubnetGroup.ts";

/**
 * Dashboard UI providers for AWS DMS (Database Migration Service) resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const COLOR = "#C925D1";

export const EndpointUI = UIProvider.succeed<Endpoint>("AWS.DMS.Endpoint", {
  displayName: "DMS Endpoint",
  icon: "plug-zap",
  color: COLOR,
  category: "database",
  summary: (ctx) => ctx.attrs?.endpointIdentifier,
  facts: (ctx) => [
    { label: "identifier", value: ctx.attrs?.endpointIdentifier, copy: true },
    { label: "arn", value: ctx.attrs?.endpointArn, mono: true, copy: true },
    { label: "type", value: ctx.attrs?.endpointType },
    { label: "engine", value: ctx.attrs?.engineName },
    { label: "status", value: ctx.attrs?.status },
  ],
});

export const ReplicationInstanceUI = UIProvider.succeed<ReplicationInstance>(
  "AWS.DMS.ReplicationInstance",
  {
    displayName: "DMS Replication Instance",
    icon: "server",
    color: COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.replicationInstanceIdentifier,
    facts: (ctx) => [
      {
        label: "identifier",
        value: ctx.attrs?.replicationInstanceIdentifier,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.replicationInstanceArn,
        mono: true,
        copy: true,
      },
      { label: "class", value: ctx.attrs?.replicationInstanceClass },
      { label: "status", value: ctx.attrs?.status },
      { label: "engine version", value: ctx.attrs?.engineVersion },
      {
        label: "private ips",
        value: ctx.attrs?.privateIpAddresses?.length
          ? ctx.attrs.privateIpAddresses.join(", ")
          : undefined,
        mono: true,
      },
    ],
  },
);

export const ReplicationSubnetGroupUI =
  UIProvider.succeed<ReplicationSubnetGroup>("AWS.DMS.ReplicationSubnetGroup", {
    displayName: "DMS Replication Subnet Group",
    icon: "network",
    color: COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.replicationSubnetGroupIdentifier,
    facts: (ctx) => [
      {
        label: "identifier",
        value: ctx.attrs?.replicationSubnetGroupIdentifier,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.replicationSubnetGroupArn,
        mono: true,
        copy: true,
      },
      { label: "vpc", value: ctx.attrs?.vpcId, mono: true },
      {
        label: "subnets",
        value: ctx.attrs?.subnetIds?.length
          ? ctx.attrs.subnetIds.join(", ")
          : undefined,
        mono: true,
      },
      { label: "status", value: ctx.attrs?.status },
    ],
  });

export const ui = () =>
  Layer.mergeAll(EndpointUI, ReplicationInstanceUI, ReplicationSubnetGroupUI);
