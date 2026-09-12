import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { DBCluster } from "./DBCluster.ts";
import type { DBClusterParameterGroup } from "./DBClusterParameterGroup.ts";
import type { DBInstance } from "./DBInstance.ts";
import type { DBParameterGroup } from "./DBParameterGroup.ts";
import type { DBSubnetGroup } from "./DBSubnetGroup.ts";

/**
 * Dashboard UI providers for AWS Neptune resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS purple/magenta database brand color. */
const COLOR = "#C925D1";

/** Extract the region segment from an AWS ARN (`arn:aws:neptune:REGION:...`). */
const regionOfArn = (arn: string | undefined): string | undefined =>
  arn?.split(":")[3] || undefined;

export const DBClusterUI = UIProvider.succeed<DBCluster>(
  "AWS.Neptune.DBCluster",
  {
    displayName: "Neptune Cluster",
    icon: "database",
    color: COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.dbClusterIdentifier,
    consoleUrl: (ctx) => {
      const region = regionOfArn(ctx.attrs?.dbClusterArn);
      return region === undefined ||
        ctx.attrs?.dbClusterIdentifier === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/neptune/home?region=${region}#database:id=${ctx.attrs.dbClusterIdentifier};is-cluster=true`;
    },
    facts: (ctx) => [
      {
        label: "identifier",
        value: ctx.attrs?.dbClusterIdentifier,
        copy: true,
      },
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
          ctx.attrs?.engineVersion === undefined
            ? ctx.attrs?.engine
            : `${ctx.attrs.engine} ${ctx.attrs.engineVersion}`,
      },
      { label: "status", value: ctx.attrs?.status },
      { label: "members", value: ctx.attrs?.dbClusterMembers?.length },
    ],
  },
);

export const DBClusterParameterGroupUI =
  UIProvider.succeed<DBClusterParameterGroup>(
    "AWS.Neptune.DBClusterParameterGroup",
    {
      displayName: "Neptune Cluster Parameter Group",
      icon: "settings",
      color: COLOR,
      category: "config",
      summary: (ctx) => ctx.attrs?.dbClusterParameterGroupName,
      consoleUrl: (ctx) => {
        const region = regionOfArn(ctx.attrs?.dbClusterParameterGroupArn);
        return region === undefined ||
          ctx.attrs?.dbClusterParameterGroupName === undefined
          ? undefined
          : `https://${region}.console.aws.amazon.com/neptune/home?region=${region}#parameter-group-details:parameter-group-name=${ctx.attrs.dbClusterParameterGroupName}`;
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

export const DBInstanceUI = UIProvider.succeed<DBInstance>(
  "AWS.Neptune.DBInstance",
  {
    displayName: "Neptune Instance",
    icon: "server",
    color: COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.dbInstanceIdentifier,
    consoleUrl: (ctx) => {
      const region = regionOfArn(ctx.attrs?.dbInstanceArn);
      return region === undefined ||
        ctx.attrs?.dbInstanceIdentifier === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/neptune/home?region=${region}#database:id=${ctx.attrs.dbInstanceIdentifier};is-cluster=false`;
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
      { label: "cluster", value: ctx.attrs?.dbClusterIdentifier },
      { label: "class", value: ctx.attrs?.dbInstanceClass },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const DBParameterGroupUI = UIProvider.succeed<DBParameterGroup>(
  "AWS.Neptune.DBParameterGroup",
  {
    displayName: "Neptune Parameter Group",
    icon: "settings",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.dbParameterGroupName,
    consoleUrl: (ctx) => {
      const region = regionOfArn(ctx.attrs?.dbParameterGroupArn);
      return region === undefined ||
        ctx.attrs?.dbParameterGroupName === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/neptune/home?region=${region}#parameter-group-details:parameter-group-name=${ctx.attrs.dbParameterGroupName}`;
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

export const DBSubnetGroupUI = UIProvider.succeed<DBSubnetGroup>(
  "AWS.Neptune.DBSubnetGroup",
  {
    displayName: "Neptune Subnet Group",
    icon: "network",
    color: COLOR,
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
    DBClusterUI,
    DBClusterParameterGroupUI,
    DBInstanceUI,
    DBParameterGroupUI,
    DBSubnetGroupUI,
  );
