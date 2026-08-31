import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Input } from "../../Input.ts";
import { connectEnvPrefix as makeConnectEnvPrefix } from "../Connection/internal.ts";
import type { SecurityGroupId } from "../EC2/SecurityGroup.ts";
import type { SubnetId } from "../EC2/Subnet.ts";
import type { ReplicationGroup } from "./ReplicationGroup.ts";

export interface ReplicationGroupConnectionInfo {
  host: string;
  port: number;
  readerHost: string | undefined;
  readerPort: number | undefined;
  tls: boolean;
}

export interface ConnectReplicationGroupOptions {
  subnetIds?: Input<SubnetId[]>;
  securityGroupIds?: Input<SecurityGroupId[]>;
}

export const replicationGroupConnectEnvPrefix = (logicalId: string) =>
  makeConnectEnvPrefix("ELASTICACHE", logicalId);

/** Publishes a provisioned Valkey/Redis endpoint to a VPC-attached function. */
export interface ConnectReplicationGroup extends Binding.Service<
  ConnectReplicationGroup,
  "AWS.ElastiCache.ConnectReplicationGroup",
  (
    group: ReplicationGroup,
    options?: ConnectReplicationGroupOptions,
  ) => Effect.Effect<Effect.Effect<ReplicationGroupConnectionInfo>>
> {}
export const ConnectReplicationGroup = Binding.Service<ConnectReplicationGroup>(
  "AWS.ElastiCache.ConnectReplicationGroup",
);
