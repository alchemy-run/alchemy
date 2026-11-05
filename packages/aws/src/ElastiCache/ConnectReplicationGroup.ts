import * as Binding from "alchemy/Binding";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { type RuntimeContext, unpackEnvValue } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
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

/**
 * Runtime binding for a provisioned Valkey or Redis OSS replication group.
 *
 * At deploy time it publishes the primary endpoint and TLS setting as
 * `ELASTICACHE_{LOGICAL_ID}_{HOST,PORT,TLS}` variables on the host Function.
 * When replicas exist, it also publishes the reader endpoint. Passing VPC
 * options attaches the host Lambda to the cache network. ElastiCache data
 * plane access is controlled by security groups, not IAM.
 *
 * ### Connecting from a Lambda
 * **Example:** Use the primary endpoint with iovalkey
 * ```typescript
 * const connect = yield* AWS.ElastiCache.ConnectReplicationGroup(cache, {
 *   subnetIds: privateSubnetIds,
 *   securityGroupIds: [functionSecurityGroup.groupId],
 * });
 *
 * // inside the handler:
 * const { host, port, tls } = yield* connect;
 * const client = new Valkey({ host, port, ...(tls ? { tls: {} } : {}) });
 * ```
 *
 * @binding
 */
export interface ConnectReplicationGroup extends Binding.Service<
  ConnectReplicationGroup,
  "AWS.ElastiCache.ConnectReplicationGroup",
  (
    group: ReplicationGroup,
    options?: ConnectReplicationGroupOptions,
  ) => Effect.Effect<Effect.Effect<ReplicationGroupConnectionInfo, never, RuntimeContext>>
> {}
export const ConnectReplicationGroup = Binding.Service<ConnectReplicationGroup>(
  "AWS.ElastiCache.ConnectReplicationGroup",
);

export const ConnectReplicationGroupHttp = Layer.effect(
  ConnectReplicationGroup,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    return Effect.fn(function* (group: ReplicationGroup, options?: ConnectReplicationGroupOptions) {
      const prefix = replicationGroupConnectEnvPrefix(group.LogicalId);
      // Outputs yield a deferred runtime effect. Keep the Output expressions
      // for deploy-time bindings, where Apply resolves them before Lambda's
      // API call, and use the deferred values only in the runtime closure.
      const configurationHost = group.configurationEndpointAddress;
      const primaryHost = group.primaryEndpointAddress;
      const configurationPort = group.configurationEndpointPort;
      const primaryPort = group.primaryEndpointPort;
      const endpointHost = Output.flatMap(configurationHost, (host) =>
        host === undefined ? primaryHost : Output.asOutput(host),
      );
      const endpointPort = Output.flatMap(configurationPort, (port) =>
        port === undefined ? primaryPort : Output.asOutput(port),
      );
      const readerHost = Output.map(group.readerEndpointAddress, (host) => host ?? "");
      const readerPort = Output.map(group.readerEndpointPort, (port) =>
        port === undefined ? "" : String(port),
      );
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.ElastiCache.ConnectReplicationGroup(${group})`({
          env: {
            [`${prefix}_HOST`]: endpointHost,
            [`${prefix}_PORT`]: Output.interpolate`${endpointPort}`,
            [`${prefix}_TLS`]: Output.map(group.transitEncryptionEnabled, String),
            [`${prefix}_READER_HOST`]: readerHost,
            [`${prefix}_READER_PORT`]: readerPort,
          },
        });
        if (options?.subnetIds || options?.securityGroupIds) {
          yield* AWSBindings.bindVpc`AWS.ElastiCache.ConnectReplicationGroup(${group})`({
            subnetIds: options?.subnetIds ?? [],
            securityGroupIds: options?.securityGroupIds ?? [],
          });
        }
      }
      return Effect.gen(function* () {
        // oxlint-disable effecttsgo/process-env-in-effect -- unpackEnvValue needs the raw env; Config would unwrap packed values
        const host = unpackEnvValue<string>(process.env[`${prefix}_HOST`]);
        if (host !== undefined) {
          const port = unpackEnvValue<number>(process.env[`${prefix}_PORT`]);
          const tls = unpackEnvValue<boolean>(process.env[`${prefix}_TLS`]);
          const readerHost = unpackEnvValue<string>(process.env[`${prefix}_READER_HOST`]);
          const readerPort = unpackEnvValue<number>(process.env[`${prefix}_READER_PORT`]);
          // oxlint-enable effecttsgo/process-env-in-effect
          if (!host || port === undefined) {
            return yield* Effect.die(
              `ElastiCache endpoint for '${group.LogicalId}' is not available`,
            );
          }
          return {
            host,
            port,
            readerHost: readerHost || undefined,
            readerPort: readerHost ? readerPort : undefined,
            tls: tls ?? true,
          };
        }
        const endpoint = yield* yield* endpointHost;
        const port = yield* yield* endpointPort;
        if (!endpoint || port === undefined) {
          return yield* Effect.die(
            `ElastiCache endpoint for '${group.LogicalId}' is not available yet`,
          );
        }
        return {
          host: endpoint,
          port,
          readerHost: yield* yield* group.readerEndpointAddress,
          readerPort: yield* yield* group.readerEndpointPort,
          tls: yield* yield* group.transitEncryptionEnabled,
        };
      });
    });
  }),
);
