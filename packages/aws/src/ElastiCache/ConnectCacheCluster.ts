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

/**
 * Runtime binding for a provisioned Memcached cluster.
 *
 * At deploy time it publishes all node endpoints as
 * `ELASTICACHE_{LOGICAL_ID}_ENDPOINTS` on the host Function. Passing VPC
 * options attaches the host Lambda to the cache network. ElastiCache data
 * plane access is controlled by security groups, not IAM.
 *
 * ### Connecting from a Lambda
 * **Example:** Resolve Memcached node endpoints
 * ```typescript
 * const connect = yield* AWS.ElastiCache.ConnectCacheCluster(cache, {
 *   subnetIds: privateSubnetIds,
 *   securityGroupIds: [functionSecurityGroup.groupId],
 * });
 *
 * // inside the handler:
 * const { endpoints } = yield* connect;
 * const endpoint = endpoints[0];
 * ```
 *
 * @binding
 */
export interface ConnectCacheCluster extends Binding.Service<
  ConnectCacheCluster,
  "AWS.ElastiCache.ConnectCacheCluster",
  (
    cluster: CacheCluster,
    options?: ConnectCacheClusterOptions,
  ) => Effect.Effect<Effect.Effect<CacheClusterConnectionInfo, never, RuntimeContext>>
> {}
export const ConnectCacheCluster = Binding.Service<ConnectCacheCluster>(
  "AWS.ElastiCache.ConnectCacheCluster",
);

export const ConnectCacheClusterHttp = Layer.effect(
  ConnectCacheCluster,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    return Effect.fn(function* (cluster: CacheCluster, options?: ConnectCacheClusterOptions) {
      const prefix = cacheClusterConnectEnvPrefix(cluster.LogicalId);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.ElastiCache.ConnectCacheCluster(${cluster})`({
          env: {
            [`${prefix}_ENDPOINTS`]: Output.map(cluster.endpoints, JSON.stringify),
            [`${prefix}_TLS`]: Output.map(cluster.transitEncryptionEnabled, (tls) =>
              String(tls ?? false),
            ),
          },
        });
        if (options?.subnetIds || options?.securityGroupIds) {
          yield* AWSBindings.bindVpc`AWS.ElastiCache.ConnectCacheCluster(${cluster})`({
            subnetIds: options?.subnetIds ?? [],
            securityGroupIds: options?.securityGroupIds ?? [],
          });
        }
      }
      return Effect.gen(function* () {
        const endpoints = unpackEnvValue<Array<{ address: string; port: number }>>(
          // oxlint-disable-next-line effecttsgo/process-env-in-effect -- unpackEnvValue needs the raw env; Config would unwrap packed values
          process.env[`${prefix}_ENDPOINTS`],
        );
        if (endpoints !== undefined) {
          if (!endpoints.length) {
            return yield* Effect.die(
              `Memcached endpoints for '${cluster.LogicalId}' are not available`,
            );
          }
          return {
            endpoints,
            // oxlint-disable-next-line effecttsgo/process-env-in-effect -- unpackEnvValue needs the raw env; Config would unwrap packed values
            tls: unpackEnvValue<boolean>(process.env[`${prefix}_TLS`]) ?? false,
          };
        }
        const clusterEndpoints = yield* yield* cluster.endpoints;
        if (!clusterEndpoints.length) {
          return yield* Effect.die(
            `Memcached endpoints for '${cluster.LogicalId}' are not available yet`,
          );
        }
        return {
          endpoints: clusterEndpoints,
          tls: yield* yield* cluster.transitEncryptionEnabled,
        };
      });
    });
  }),
);
