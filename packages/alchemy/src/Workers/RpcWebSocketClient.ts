import type * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import type * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

export interface LayerOptions {
  /** Options passed to Effect's WebSocket transport. */
  readonly socket?: Parameters<typeof Socket.layerWebSocket>[1];
  /** Options passed to Effect's socket RPC protocol. */
  readonly protocol?: Parameters<typeof RpcClient.layerProtocolSocket>[0];
  /** Options passed to the grouped Effect RPC client. */
  readonly client?: Omit<NonNullable<Parameters<typeof RpcClient.make>[1]>, "flatten">;
  /**
   * Serialization matching the server. Alchemy's RpcDurableObject uses JSON.
   * @default RpcSerialization.json
   */
  readonly serialization?: RpcSerialization.RpcSerialization["Service"];
}

type ProtocolOptions = NonNullable<LayerOptions["protocol"]>;

/**
 * Effect's pinger drops the connection when no frame arrived within
 * `pingTimeout` of a ping tick, and `pingTimeout` defaults to the interval:
 * a Pong that returns faster than the timer's own drift (any local server)
 * then misses the deadline by a few milliseconds. Allow two intervals.
 */
const withPingTimeout = (protocol: LayerOptions["protocol"]): ProtocolOptions => ({
  ...protocol,
  pingTimeout:
    protocol?.pingTimeout ??
    Duration.times(Duration.fromInputUnsafe(protocol?.pingInterval ?? "5 seconds"), 2),
});

/**
 * Provide a typed RPC client and its WebSocket connection to a hibernatable
 * `RpcDurableObject` for the Layer's lifetime. Engines re-export this with
 * their own documentation.
 *
 * @internal
 */
export const layer = <I, Rpcs extends Rpc.Any>(
  service: Context.Key<I, RpcClient.RpcClient<Rpcs, RpcClientError>>,
  group: RpcGroup.RpcGroup<Rpcs>,
  url: Parameters<typeof Socket.layerWebSocket>[0],
  options: LayerOptions = {},
): Layer.Layer<I, never, Socket.WebSocketConstructor | Rpc.MiddlewareClient<Rpcs>> =>
  Layer.effect(service, RpcClient.make(group, options.client)).pipe(
    Layer.provide(
      RpcClient.layerProtocolSocket(withPingTimeout(options.protocol)).pipe(
        Layer.provide(
          Layer.mergeAll(
            Socket.layerWebSocket(url, options.socket),
            Layer.succeed(
              RpcSerialization.RpcSerialization,
              options.serialization ?? RpcSerialization.json,
            ),
          ),
        ),
      ),
    ),
  );
