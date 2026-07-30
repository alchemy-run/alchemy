import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ACL } from "./ACL.ts";
import type { Cluster } from "./Cluster.ts";
import type { ParameterGroup } from "./ParameterGroup.ts";
import type { SubnetGroup } from "./SubnetGroup.ts";
import type { User } from "./User.ts";

/**
 * Dashboard UI providers for AWS MemoryDB resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Database (MemoryDB) brand purple/magenta. */
const COLOR = "#C925D1";

export const ClusterUI = UIProvider.succeed<Cluster>("AWS.MemoryDB.Cluster", {
  displayName: "MemoryDB Cluster",
  icon: "database",
  color: COLOR,
  category: "database",
  summary: (ctx) => ctx.attrs?.clusterName,
  facts: (ctx) => [
    { label: "cluster", value: ctx.attrs?.clusterName, copy: true },
    { label: "arn", value: ctx.attrs?.clusterArn, mono: true, copy: true },
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
    { label: "node type", value: ctx.attrs?.nodeType },
    { label: "status", value: ctx.attrs?.status },
    { label: "acl", value: ctx.attrs?.aclName },
    { label: "shards", value: ctx.attrs?.numberOfShards },
  ],
});

export const ACLUI = UIProvider.succeed<ACL>("AWS.MemoryDB.ACL", {
  displayName: "MemoryDB ACL",
  icon: "shield",
  color: COLOR,
  category: "security",
  summary: (ctx) => ctx.attrs?.aclName,
  facts: (ctx) => [
    { label: "acl", value: ctx.attrs?.aclName, copy: true },
    { label: "arn", value: ctx.attrs?.aclArn, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.status },
    {
      label: "users",
      value: ctx.attrs?.userNames?.length
        ? ctx.attrs.userNames.join(", ")
        : undefined,
    },
  ],
});

export const ParameterGroupUI = UIProvider.succeed<ParameterGroup>(
  "AWS.MemoryDB.ParameterGroup",
  {
    displayName: "MemoryDB Parameter Group",
    icon: "settings-2",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.parameterGroupName,
    facts: (ctx) => [
      { label: "group", value: ctx.attrs?.parameterGroupName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.parameterGroupArn,
        mono: true,
        copy: true,
      },
      { label: "family", value: ctx.attrs?.family },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const SubnetGroupUI = UIProvider.succeed<SubnetGroup>(
  "AWS.MemoryDB.SubnetGroup",
  {
    displayName: "MemoryDB Subnet Group",
    icon: "network",
    color: COLOR,
    category: "network",
    summary: (ctx) => ctx.attrs?.subnetGroupName,
    facts: (ctx) => [
      { label: "group", value: ctx.attrs?.subnetGroupName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.subnetGroupArn,
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
    ],
  },
);

export const UserUI = UIProvider.succeed<User>("AWS.MemoryDB.User", {
  displayName: "MemoryDB User",
  icon: "user",
  color: COLOR,
  category: "security",
  summary: (ctx) => ctx.attrs?.userName,
  facts: (ctx) => [
    { label: "user", value: ctx.attrs?.userName, copy: true },
    { label: "arn", value: ctx.attrs?.userArn, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.status },
    { label: "access string", value: ctx.attrs?.accessString, mono: true },
    { label: "authentication", value: ctx.attrs?.authenticationType },
  ],
});

export const ui = () =>
  Layer.mergeAll(ClusterUI, ACLUI, ParameterGroupUI, SubnetGroupUI, UserUI);
