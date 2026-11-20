import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { connectEnvPrefix as makeConnectEnvPrefix } from "../Connection/internal.ts";
import type { ServerlessCache } from "./ServerlessCache.ts";

/**
 * Connection descriptor for an ElastiCache serverless cache. Alchemy does
 * not bundle a valkey/redis client — pass these settings to the client of
 * your choice (`iovalkey`, `ioredis`, `redis`, `memjs`, ...).
 */
export interface CacheConnectionInfo {
  /** Primary endpoint hostname. */
  host: string;
  /** Primary endpoint port (6379 for valkey/redis, 11211 for memcached). */
  port: number;
  /** Reader endpoint hostname, when the engine exposes one. */
  readerHost: string | undefined;
  /** Reader endpoint port, when the engine exposes one. */
  readerPort: number | undefined;
  /**
   * Serverless caches only accept TLS connections — always `true`.
   */
  tls: boolean;
}

/**
 * Environment variable prefix under which {@link Connect} publishes the
 * cache endpoint on the host Function, derived from the cache's logical ID.
 * A cache with logical ID `SessionCache` yields `ELASTICACHE_SESSIONCACHE`
 * and the variables `ELASTICACHE_SESSIONCACHE_HOST`,
 * `ELASTICACHE_SESSIONCACHE_PORT`, and `ELASTICACHE_SESSIONCACHE_TLS`.
 */
export const connectEnvPrefix = (logicalId: string): string =>
  makeConnectEnvPrefix("ELASTICACHE", logicalId);

/**
 * Runtime binding that resolves connection settings for an ElastiCache
 * serverless cache.
 *
 * This is an environment-only binding: ElastiCache has no IAM-gated data
 * plane for classic (non-RBAC) access, so the binding injects the cache's
 * endpoint host/port as environment variables on the host Function and
 * returns a typed {@link CacheConnectionInfo} at runtime. Network access is
 * governed by VPC security groups, NOT IAM — the host Function must:
 *
 * 1. be attached to the cache's VPC (`vpc: { subnetIds, securityGroupIds }`), and
 * 2. have a security group allowed ingress on the cache's port by one of the
 *    cache's `securityGroupIds`.
 * ### Connecting to a Cache
 * **Example:** Resolve Connection Info inside a Function
 * ```typescript
 * const connect = yield* ElastiCache.Connect(cache);
 * // inside a handler:
 * const { host, port, tls } = yield* connect;
 * ```
 *
 * @binding
 */
export interface Connect extends Binding.Service<
  Connect,
  "AWS.ElastiCache.Connect",
  (
    cache: ServerlessCache,
  ) => Effect.Effect<Effect.Effect<CacheConnectionInfo, never, RuntimeContext>>
> {}
export const Connect = Binding.Service<Connect>("AWS.ElastiCache.Connect");

/**
 * Environment-only implementation of {@link Connect}. At deploy time it
 * publishes the cache endpoint as `ELASTICACHE_{LOGICAL_ID}_{HOST,PORT,TLS}`
 * environment variables on the host Function; at runtime it resolves the
 * same values into a typed connection descriptor. No IAM policy is attached
 * — the classic valkey/redis/memcached data plane is governed by VPC
 * security groups, not IAM.
 */
export const ConnectHttp = Layer.effect(
  Connect,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    return Effect.fn(function* (cache: ServerlessCache) {
      const Host = yield* cache.endpointAddress;
      const Port = yield* cache.endpointPort;
      const ReaderHost = yield* cache.readerEndpointAddress;
      const ReaderPort = yield* cache.readerEndpointPort;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const prefix = connectEnvPrefix(cache.LogicalId);
        yield* bind`AWS.ElastiCache.Connect(${cache})`({
          env: {
            [`${prefix}_HOST`]: cache.endpointAddress,
            // Lambda environment variables are strings — stringify the port.
            [`${prefix}_PORT`]: Output.interpolate`${cache.endpointPort}`,
            // Serverless caches are TLS-only.
            [`${prefix}_TLS`]: "true",
          },
        });
      }

      return Effect.gen(function* () {
        const host = yield* Host;
        const port = yield* Port;
        const readerHost = yield* ReaderHost;
        const readerPort = yield* ReaderPort;
        if (!host || port === undefined) {
          return yield* Effect.die(
            `ElastiCache endpoint for '${cache.LogicalId}' is not available yet`,
          );
        }
        return {
          host,
          port,
          readerHost,
          readerPort,
          tls: true,
        };
      });
    });
  }),
);
