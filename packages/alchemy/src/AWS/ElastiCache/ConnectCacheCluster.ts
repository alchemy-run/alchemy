import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Input } from "../../Input.ts";
import { connectEnvPrefix as makeConnectEnvPrefix } from "../Connection/internal.ts";
import type { SecurityGroupId } from "../EC2/SecurityGroup.ts";
import type { SubnetId } from "../EC2/Subnet.ts";
import type { CacheCluster } from "./CacheCluster.ts";

export interface CacheClusterConnectionInfo {
  endpoints: Array<{ address: string; port: number }>;
  tls: boolean;
}

export interface ConnectCacheClusterOptions {
  subnetIds?: Input<SubnetId[]>;
  securityGroupIds?: Input<SecurityGroupId[]>;
}

export const cacheClusterConnectEnvPrefix = (logicalId: string) =>
  makeConnectEnvPrefix("ELASTICACHE", logicalId);

/** Publishes all provisioned Memcached nodes to a VPC-attached function. */
export interface ConnectCacheCluster extends Binding.Service<
  ConnectCacheCluster,
  "AWS.ElastiCache.ConnectCacheCluster",
  (
    cluster: CacheCluster,
    options?: ConnectCacheClusterOptions,
  ) => Effect.Effect<Effect.Effect<CacheClusterConnectionInfo>>
> {}
export const ConnectCacheCluster = Binding.Service<ConnectCacheCluster>(
  "AWS.ElastiCache.ConnectCacheCluster",
);
