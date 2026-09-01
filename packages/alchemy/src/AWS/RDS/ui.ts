import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { DBCluster } from "./DBCluster.ts";
import type { DBClusterEndpoint } from "./DBClusterEndpoint.ts";
import type { DBClusterParameterGroup } from "./DBClusterParameterGroup.ts";
import type { DBInstance } from "./DBInstance.ts";
import type { DBParameterGroup } from "./DBParameterGroup.ts";
import type { DBProxy } from "./DBProxy.ts";
import type { DBProxyEndpoint } from "./DBProxyEndpoint.ts";
import type { DBProxyTargetGroup } from "./DBProxyTargetGroup.ts";
import type { DBSubnetGroup } from "./DBSubnetGroup.ts";

/**
 * Dashboard UI providers for AWS RDS resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS purple/magenta database brand color. */
const RDS_COLOR = "#C925D1";

/** Extract the region segment from an AWS ARN (`arn:aws:rds:REGION:...`). */
const regionOfArn = (arn: string | undefined): string | undefined =>
  arn?.split(":")[3] || undefined;

export const DBInstanceUI = UIProvider.succeed<DBInstance>(
  "AWS.RDS.DBInstance",
  {
    displayName: "RDS Instance",
    icon: "database",
    color: RDS_COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.dbInstanceIdentifier,
    consoleUrl: (ctx) => {
      const region = regionOfArn(ctx.attrs?.dbInstanceArn);
      return region === undefined ||
        ctx.attrs?.dbInstanceIdentifier === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/rds/home?region=${region}#database:id=${ctx.attrs.dbInstanceIdentifier};is-cluster=false`;
    },
    facts: (ctx) => [
      {
        label: "identifier",
        value: ctx.attrs?.dbInstanceIdentifier,
        copy: true,
      },
      { label: "arn", value: ctx.attrs?.dbInstanceArn, mono: true, copy: true },
      {
        label: "endpoint",
        value:
          ctx.attrs?.endpointAddress === undefined
            ? undefined
            : `${ctx.attrs.endpointAddress}:${ctx.attrs.endpointPort ?? ""}`,
        mono: true,
        copy: true,
      },
      {
        label: "engine",
        value:
          ctx.attrs?.engine === undefined
            ? undefined
            : `${ctx.attrs.engine}${ctx.attrs.engineVersion ? ` ${ctx.attrs.engineVersion}` : ""}`,
      },
      { label: "class", value: ctx.attrs?.dbInstanceClass },
      { label: "status", value: ctx.attrs?.status },
      { label: "multi-az", value: ctx.attrs?.multiAZ },
      {
        label: "storage",
        value:
          ctx.attrs?.allocatedStorage === undefined
            ? undefined
            : `${ctx.attrs.allocatedStorage} GiB${ctx.attrs.storageType ? ` (${ctx.attrs.storageType})` : ""}`,
      },
    ],
  },
);

export const DBClusterUI = UIProvider.succeed<DBCluster>("AWS.RDS.DBCluster", {
  displayName: "RDS Cluster",
  icon: "database-zap",
  color: RDS_COLOR,
  category: "database",
  summary: (ctx) => ctx.attrs?.dbClusterIdentifier,
  consoleUrl: (ctx) => {
    const region = regionOfArn(ctx.attrs?.dbClusterArn);
    return region === undefined || ctx.attrs?.dbClusterIdentifier === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/rds/home?region=${region}#database:id=${ctx.attrs.dbClusterIdentifier};is-cluster=true`;
  },
  facts: (ctx) => [
    { label: "identifier", value: ctx.attrs?.dbClusterIdentifier, copy: true },
    { label: "arn", value: ctx.attrs?.dbClusterArn, mono: true, copy: true },
    { label: "endpoint", value: ctx.attrs?.endpoint, mono: true, copy: true },
    {
      label: "reader endpoint",
      value: ctx.attrs?.readerEndpoint,
      mono: true,
      copy: true,
    },
    {
      label: "engine",
      value:
        ctx.attrs?.engine === undefined
          ? undefined
          : `${ctx.attrs.engine}${ctx.attrs.engineVersion ? ` ${ctx.attrs.engineVersion}` : ""}`,
    },
    { label: "status", value: ctx.attrs?.status },
    { label: "database", value: ctx.attrs?.databaseName },
    { label: "members", value: ctx.attrs?.dbClusterMembers?.length },
  ],
});

export const DBClusterEndpointUI = UIProvider.succeed<DBClusterEndpoint>(
  "AWS.RDS.DBClusterEndpoint",
  {
    displayName: "RDS Cluster Endpoint",
    icon: "plug",
    color: RDS_COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.dbClusterEndpointIdentifier,
    facts: (ctx) => [
      {
        label: "identifier",
        value: ctx.attrs?.dbClusterEndpointIdentifier,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.dbClusterEndpointArn,
        mono: true,
        copy: true,
      },
      { label: "endpoint", value: ctx.attrs?.endpoint, mono: true, copy: true },
      { label: "cluster", value: ctx.attrs?.dbClusterIdentifier },
      {
        label: "type",
        value: ctx.attrs?.customEndpointType ?? ctx.attrs?.endpointType,
      },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const DBClusterParameterGroupUI =
  UIProvider.succeed<DBClusterParameterGroup>(
    "AWS.RDS.DBClusterParameterGroup",
    {
      displayName: "RDS Cluster Parameter Group",
      icon: "settings-2",
      color: RDS_COLOR,
      category: "config",
      summary: (ctx) => ctx.attrs?.dbClusterParameterGroupName,
      consoleUrl: (ctx) => {
        const region = regionOfArn(ctx.attrs?.dbClusterParameterGroupArn);
        return region === undefined ||
          ctx.attrs?.dbClusterParameterGroupName === undefined
          ? undefined
          : `https://${region}.console.aws.amazon.com/rds/home?region=${region}#parameter-group-details:parameter-group-name=${ctx.attrs.dbClusterParameterGroupName}`;
      },
      facts: (ctx) => [
        {
          label: "name",
          value: ctx.attrs?.dbClusterParameterGroupName,
          copy: true,
        },
        {
          label: "arn",
          value: ctx.attrs?.dbClusterParameterGroupArn,
          mono: true,
          copy: true,
        },
        { label: "family", value: ctx.attrs?.family },
        { label: "description", value: ctx.attrs?.description },
      ],
    },
  );

export const DBParameterGroupUI = UIProvider.succeed<DBParameterGroup>(
  "AWS.RDS.DBParameterGroup",
  {
    displayName: "RDS Parameter Group",
    icon: "settings-2",
    color: RDS_COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.dbParameterGroupName,
    consoleUrl: (ctx) => {
      const region = regionOfArn(ctx.attrs?.dbParameterGroupArn);
      return region === undefined ||
        ctx.attrs?.dbParameterGroupName === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/rds/home?region=${region}#parameter-group-details:parameter-group-name=${ctx.attrs.dbParameterGroupName}`;
    },
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.dbParameterGroupName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.dbParameterGroupArn,
        mono: true,
        copy: true,
      },
      { label: "family", value: ctx.attrs?.family },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const DBProxyUI = UIProvider.succeed<DBProxy>("AWS.RDS.DBProxy", {
  displayName: "RDS Proxy",
  icon: "waypoints",
  color: RDS_COLOR,
  category: "database",
  summary: (ctx) => ctx.attrs?.dbProxyName,
  consoleUrl: (ctx) => {
    const region = regionOfArn(ctx.attrs?.dbProxyArn);
    return region === undefined || ctx.attrs?.dbProxyName === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/rds/home?region=${region}#proxy:id=${ctx.attrs.dbProxyName}`;
  },
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.dbProxyName, copy: true },
    { label: "arn", value: ctx.attrs?.dbProxyArn, mono: true, copy: true },
    { label: "endpoint", value: ctx.attrs?.endpoint, mono: true, copy: true },
    { label: "engine family", value: ctx.attrs?.engineFamily },
    { label: "status", value: ctx.attrs?.status },
    { label: "require tls", value: ctx.attrs?.requireTLS },
    { label: "vpc", value: ctx.attrs?.vpcId, mono: true },
  ],
});

export const DBProxyEndpointUI = UIProvider.succeed<DBProxyEndpoint>(
  "AWS.RDS.DBProxyEndpoint",
  {
    displayName: "RDS Proxy Endpoint",
    icon: "plug-zap",
    color: RDS_COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.dbProxyEndpointName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.dbProxyEndpointName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.dbProxyEndpointArn,
        mono: true,
        copy: true,
      },
      { label: "endpoint", value: ctx.attrs?.endpoint, mono: true, copy: true },
      { label: "proxy", value: ctx.attrs?.dbProxyName },
      { label: "target role", value: ctx.attrs?.targetRole },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const DBProxyTargetGroupUI = UIProvider.succeed<DBProxyTargetGroup>(
  "AWS.RDS.DBProxyTargetGroup",
  {
    displayName: "RDS Proxy Target Group",
    icon: "target",
    color: RDS_COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.targetGroupName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.targetGroupName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.targetGroupArn,
        mono: true,
        copy: true,
      },
      { label: "proxy", value: ctx.attrs?.dbProxyName },
      { label: "status", value: ctx.attrs?.status },
      { label: "default", value: ctx.attrs?.isDefault },
      {
        label: "targets",
        value:
          ctx.attrs?.dbClusterIdentifiers === undefined &&
          ctx.attrs?.dbInstanceIdentifiers === undefined
            ? undefined
            : [
                ...(ctx.attrs?.dbClusterIdentifiers ?? []),
                ...(ctx.attrs?.dbInstanceIdentifiers ?? []),
              ].join(", ") || undefined,
      },
    ],
  },
);

export const DBSubnetGroupUI = UIProvider.succeed<DBSubnetGroup>(
  "AWS.RDS.DBSubnetGroup",
  {
    displayName: "RDS Subnet Group",
    icon: "network",
    color: RDS_COLOR,
    category: "network",
    summary: (ctx) => ctx.attrs?.dbSubnetGroupName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.dbSubnetGroupName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.dbSubnetGroupArn,
        mono: true,
        copy: true,
      },
      { label: "vpc", value: ctx.attrs?.vpcId, mono: true },
      { label: "subnets", value: ctx.attrs?.subnetIds?.join(", "), mono: true },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    DBInstanceUI,
    DBClusterUI,
    DBClusterEndpointUI,
    DBClusterParameterGroupUI,
    DBParameterGroupUI,
    DBProxyUI,
    DBProxyEndpointUI,
    DBProxyTargetGroupUI,
    DBSubnetGroupUI,
  );
