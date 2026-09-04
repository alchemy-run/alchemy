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

const ELASTICACHE_COLOR = "#C925D1";

const endpoint = (
  address: string | undefined,
  port: number | undefined,
): string | undefined => (address ? `${address}:${port ?? ""}` : undefined);

export const ServerlessCacheUI = UIProvider.succeed<ServerlessCache>(
  "AWS.ElastiCache.ServerlessCache",
  {
    displayName: "ElastiCache Serverless Cache",
    icon: "database",
    color: ELASTICACHE_COLOR,
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
        value: endpoint(ctx.attrs?.endpointAddress, ctx.attrs?.endpointPort),
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
    color: ELASTICACHE_COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.cacheClusterId,
    facts: (ctx) => [
      { label: "cluster", value: ctx.attrs?.cacheClusterId, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.cacheClusterArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      { label: "engine", value: ctx.attrs?.engine },
      { label: "version", value: ctx.attrs?.engineVersion },
      { label: "node type", value: ctx.attrs?.nodeType },
      { label: "nodes", value: ctx.attrs?.endpoints?.length },
      {
        label: "endpoints",
        value: ctx.attrs?.endpoints?.length
          ? ctx.attrs.endpoints.map((e) => `${e.address}:${e.port}`).join(", ")
          : undefined,
        mono: true,
        copy: true,
      },
      {
        label: "in-transit encryption",
        value: ctx.attrs?.transitEncryptionEnabled,
      },
    ],
  },
);

export const ReplicationGroupUI = UIProvider.succeed<ReplicationGroup>(
  "AWS.ElastiCache.ReplicationGroup",
  {
    displayName: "ElastiCache Replication Group",
    icon: "database",
    color: ELASTICACHE_COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.replicationGroupId,
    facts: (ctx) => [
      {
        label: "replication group",
        value: ctx.attrs?.replicationGroupId,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.replicationGroupArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      { label: "engine", value: ctx.attrs?.engine },
      { label: "version", value: ctx.attrs?.engineVersion },
      { label: "node type", value: ctx.attrs?.nodeType },
      { label: "shards", value: ctx.attrs?.nodeGroupIds?.length },
      {
        label: "primary endpoint",
        value: endpoint(
          ctx.attrs?.primaryEndpointAddress,
          ctx.attrs?.primaryEndpointPort,
        ),
        mono: true,
        copy: true,
      },
      {
        label: "reader endpoint",
        value: endpoint(
          ctx.attrs?.readerEndpointAddress,
          ctx.attrs?.readerEndpointPort,
        ),
        mono: true,
        copy: true,
      },
      {
        label: "configuration endpoint",
        value: endpoint(
          ctx.attrs?.configurationEndpointAddress,
          ctx.attrs?.configurationEndpointPort,
        ),
        mono: true,
        copy: true,
      },
      {
        label: "in-transit encryption",
        value: ctx.attrs?.transitEncryptionEnabled,
      },
    ],
  },
);

export const SubnetGroupUI = UIProvider.succeed<SubnetGroup>(
  "AWS.ElastiCache.SubnetGroup",
  {
    displayName: "ElastiCache Subnet Group",
    icon: "network",
    color: ELASTICACHE_COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.subnetGroupName,
    facts: (ctx) => [
      { label: "subnet group", value: ctx.attrs?.subnetGroupName, copy: true },
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
