import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { CacheCluster } from "./CacheCluster.ts";
import type { ReplicationGroup } from "./ReplicationGroup.ts";
import type { ServerlessCache } from "./ServerlessCache.ts";
import type { SubnetGroup } from "./SubnetGroup.ts";

/**
 * Dashboard UI providers for AWS ElastiCache resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** Extract the region segment from an AWS ARN (arn:aws:svc:REGION:...). */
const regionOfArn = (arn: string | undefined): string | undefined =>
  arn?.split(":")[3] || undefined;

const elasticacheConsole = (
  region: string | undefined,
  hash: string,
): string | undefined =>
  region === undefined
    ? undefined
    : `https://${region}.console.aws.amazon.com/elasticache/home?region=${region}#${hash}`;

export const ServerlessCacheUI = UIProvider.succeed<ServerlessCache>(
  "AWS.ElastiCache.ServerlessCache",
  {
    displayName: "ElastiCache Serverless Cache",
    icon: "database",
    color: "#C925D1",
    category: "database",
    summary: (ctx) => ctx.attrs?.serverlessCacheName,
    facts: (ctx) => [
      {
        label: "cache",
        value: ctx.attrs?.serverlessCacheName,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.serverlessCacheArn,
        mono: true,
        copy: true,
      },
      { label: "engine", value: ctx.attrs?.engine },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "endpoint",
        value: ctx.attrs?.endpointAddress
          ? `${ctx.attrs.endpointAddress}:${ctx.attrs.endpointPort ?? ""}`
          : undefined,
        mono: true,
        copy: true,
      },
      { label: "version", value: ctx.attrs?.fullEngineVersion },
    ],
  },
);

export const CacheClusterUI = UIProvider.succeed<CacheCluster>(
  "AWS.ElastiCache.CacheCluster",
  {
    displayName: "ElastiCache Cluster",
    icon: "database",
    color: "#C925D1",
    category: "database",
    summary: (ctx) => ctx.attrs?.cacheClusterId,
    consoleUrl: (ctx) =>
      ctx.attrs?.cacheClusterId === undefined
        ? undefined
        : elasticacheConsole(
            regionOfArn(ctx.attrs?.cacheClusterArn),
            `/memcached/${ctx.attrs.cacheClusterId}`,
          ),
    facts: (ctx) => [
      { label: "cluster", value: ctx.attrs?.cacheClusterId, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.cacheClusterArn,
        mono: true,
        copy: true,
      },
      { label: "engine", value: ctx.attrs?.engine },
      { label: "version", value: ctx.attrs?.engineVersion },
      { label: "status", value: ctx.attrs?.status },
      { label: "node type", value: ctx.attrs?.nodeType },
      {
        label: "endpoint",
        value: ctx.attrs?.endpoints?.[0]
          ? `${ctx.attrs.endpoints[0].address}:${ctx.attrs.endpoints[0].port}`
          : undefined,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const ReplicationGroupUI = UIProvider.succeed<ReplicationGroup>(
  "AWS.ElastiCache.ReplicationGroup",
  {
    displayName: "ElastiCache Replication Group",
    icon: "database",
    color: "#C925D1",
    category: "database",
    summary: (ctx) => ctx.attrs?.replicationGroupId,
    consoleUrl: (ctx) =>
      ctx.attrs?.replicationGroupId === undefined
        ? undefined
        : elasticacheConsole(
            regionOfArn(ctx.attrs?.replicationGroupArn),
            `/${ctx.attrs.engine === "valkey" ? "valkey" : "redis"}/${ctx.attrs.replicationGroupId}`,
          ),
    facts: (ctx) => [
      { label: "group", value: ctx.attrs?.replicationGroupId, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.replicationGroupArn,
        mono: true,
        copy: true,
      },
      { label: "engine", value: ctx.attrs?.engine },
      { label: "version", value: ctx.attrs?.engineVersion },
      { label: "status", value: ctx.attrs?.status },
      { label: "node type", value: ctx.attrs?.nodeType },
      {
        label: "endpoint",
        value: ctx.attrs?.primaryEndpointAddress
          ? `${ctx.attrs.primaryEndpointAddress}:${ctx.attrs.primaryEndpointPort ?? ""}`
          : ctx.attrs?.configurationEndpointAddress
            ? `${ctx.attrs.configurationEndpointAddress}:${ctx.attrs.configurationEndpointPort ?? ""}`
            : undefined,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const SubnetGroupUI = UIProvider.succeed<SubnetGroup>(
  "AWS.ElastiCache.SubnetGroup",
  {
    displayName: "ElastiCache Subnet Group",
    icon: "network",
    color: "#C925D1",
    category: "database",
    summary: (ctx) => ctx.attrs?.subnetGroupName,
    consoleUrl: (ctx) =>
      ctx.attrs?.subnetGroupName === undefined
        ? undefined
        : elasticacheConsole(
            regionOfArn(ctx.attrs?.subnetGroupArn),
            `/subnet-groups/${ctx.attrs.subnetGroupName}`,
          ),
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.subnetGroupName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.subnetGroupArn,
        mono: true,
        copy: true,
      },
      { label: "vpc", value: ctx.attrs?.vpcId, mono: true },
      { label: "subnets", value: ctx.attrs?.subnetIds?.length },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    ServerlessCacheUI,
    CacheClusterUI,
    ReplicationGroupUI,
    SubnetGroupUI,
  );
