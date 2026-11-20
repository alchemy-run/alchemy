import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Cluster } from "./Cluster.ts";
import {
  DAX_PROTOCOL_ACTIONS,
  DAX_READ_ACTIONS,
  makeDaxConnectHttpBinding,
  DAX_WRITE_ACTIONS,
} from "./ConnectHttp.ts";
import { connectEnvPrefix } from "./ConnectHttp.ts";

export { connectEnvPrefix };

/**
 * Connection descriptor for a DAX cluster. Alchemy does not bundle a DAX
 * client — pass these settings to the DAX SDK client of your choice
 * (`amazon-dax-client`, `@amazon-dax-sdk/lib-dax`, ...), which speaks the
 * DynamoDB-compatible DAX protocol against the cluster's discovery endpoint.
 */
export interface ClusterConnectionInfo {
  /** Discovery endpoint hostname. */
  host: string;
  /** Discovery endpoint port (8111 unencrypted, 9111 for TLS). */
  port: number;
  /**
   * Full `dax://` (or `daxs://` for TLS) discovery endpoint URL — the value
   * DAX SDK clients accept directly.
   */
  url: string;
  /** Whether the cluster endpoint requires encryption in transit (TLS). */
  tls: boolean;
}

/**
 * Read-only runtime access to a DAX {@link Cluster}'s data plane.
 *
 * Grants the read-side DAX IAM actions (`dax:GetItem`, `dax:BatchGetItem`,
 * `dax:Query`, `dax:Scan`, plus the protocol actions every DAX client
 * needs) on the cluster ARN, publishes the discovery endpoint as environment
 * variables on the host Function, and resolves a typed
 * {@link ClusterConnectionInfo} at runtime.
 *
 * The DAX data plane is VPC-only — the host Function must be attached to the
 * cluster's VPC and allowed ingress by the cluster's security groups.
 * Provide the implementation with `Effect.provide(AWS.DAX.ConnectReadHttp)`.
 * ### Connecting to a Cluster
 * **Example:** Resolve Read-Only Connection Info inside a Function
 * ```typescript
 * const connect = yield* DAX.ConnectRead(cluster);
 * // inside a handler:
 * const { url, tls } = yield* connect;
 * ```
 *
 * @binding
 */
export interface ConnectRead extends Binding.Service<
  ConnectRead,
  "AWS.DAX.ConnectRead",
  (cluster: Cluster) => Effect.Effect<Effect.Effect<ClusterConnectionInfo, never, RuntimeContext>>
> {}
export const ConnectRead = Binding.Service<ConnectRead>("AWS.DAX.ConnectRead");

/**
 * Write-only runtime access to a DAX {@link Cluster}'s data plane.
 *
 * Grants the write-side DAX IAM actions (`dax:PutItem`, `dax:UpdateItem`,
 * `dax:DeleteItem`, `dax:BatchWriteItem`, `dax:ConditionCheckItem`, plus the
 * protocol actions every DAX client needs) on the cluster ARN, publishes the
 * discovery endpoint as environment variables on the host Function, and
 * resolves a typed {@link ClusterConnectionInfo} at runtime.
 *
 * The DAX data plane is VPC-only — the host Function must be attached to the
 * cluster's VPC and allowed ingress by the cluster's security groups.
 * Provide the implementation with `Effect.provide(AWS.DAX.ConnectWriteHttp)`.
 * ### Connecting to a Cluster
 * **Example:** Resolve Write-Only Connection Info inside a Function
 * ```typescript
 * const connect = yield* DAX.ConnectWrite(cluster);
 * // inside a handler:
 * const { url } = yield* connect;
 * ```
 *
 * @binding
 */
export interface ConnectWrite extends Binding.Service<
  ConnectWrite,
  "AWS.DAX.ConnectWrite",
  (cluster: Cluster) => Effect.Effect<Effect.Effect<ClusterConnectionInfo, never, RuntimeContext>>
> {}
export const ConnectWrite = Binding.Service<ConnectWrite>("AWS.DAX.ConnectWrite");

/**
 * Full read-write runtime access to a DAX {@link Cluster}'s data plane.
 *
 * Grants both the read- and write-side DAX IAM actions on the cluster ARN,
 * publishes the discovery endpoint as environment variables on the host
 * Function, and resolves a typed {@link ClusterConnectionInfo} at runtime.
 *
 * The DAX data plane is VPC-only — the host Function must be attached to the
 * cluster's VPC and allowed ingress by the cluster's security groups.
 * Provide the implementation with
 * `Effect.provide(AWS.DAX.ConnectReadWriteHttp)`.
 * ### Connecting to a Cluster
 * **Example:** Resolve Connection Info inside a Function
 * ```typescript
 * const connect = yield* DAX.ConnectReadWrite(cluster);
 * // inside a handler:
 * const { host, port, url, tls } = yield* connect;
 * ```
 *
 * @binding
 */
export interface ConnectReadWrite extends Binding.Service<
  ConnectReadWrite,
  "AWS.DAX.ConnectReadWrite",
  (cluster: Cluster) => Effect.Effect<Effect.Effect<ClusterConnectionInfo, never, RuntimeContext>>
> {}
export const ConnectReadWrite = Binding.Service<ConnectReadWrite>("AWS.DAX.ConnectReadWrite");

export const ConnectReadHttp = Layer.effect(
  ConnectRead,
  makeDaxConnectHttpBinding({
    tag: "AWS.DAX.ConnectRead",
    actions: [...DAX_PROTOCOL_ACTIONS, ...DAX_READ_ACTIONS],
  }),
);

export const ConnectReadWriteHttp = Layer.effect(
  ConnectReadWrite,
  makeDaxConnectHttpBinding({
    tag: "AWS.DAX.ConnectReadWrite",
    actions: [...DAX_PROTOCOL_ACTIONS, ...DAX_READ_ACTIONS, ...DAX_WRITE_ACTIONS],
  }),
);

export const ConnectWriteHttp = Layer.effect(
  ConnectWrite,
  makeDaxConnectHttpBinding({
    tag: "AWS.DAX.ConnectWrite",
    actions: [...DAX_PROTOCOL_ACTIONS, ...DAX_WRITE_ACTIONS],
  }),
);
