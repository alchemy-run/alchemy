import { layer as sharedLayer } from "../Workers/RpcWebSocketClient.ts";
export type { LayerOptions } from "../Workers/RpcWebSocketClient.ts";

/**
 * Provide a typed RPC client and its WebSocket connection for the Layer's lifetime.
 *
 * Import from `alchemy/Celld/RpcWebSocketClient` in browsers to avoid
 * Celld server modules. Provide `Socket.layerWebSocketConstructorGlobal`
 * in a browser, or the corresponding constructor Layer for another platform.
 * RPC client middleware remains an explicit dependency.
 *
 * Provide this Layer around the application or session that shares the client.
 * Releasing the Layer closes the connection on success, failure, or interruption.
 * Ordinary calls need no caller Scope; streaming calls using `{ asQueue: true }`
 * still require a Scope for the queue consumer. Inside a Celld Worker,
 * provide this Layer per request, not in the isolate-scoped initializer.
 *
 * ### Browser Client
 * **Example:** Provide a client for the application's program
 * ```typescript
 * import * as RpcWebSocketClient from "alchemy/Celld/RpcWebSocketClient";
 * import { Context, Effect, Layer } from "effect";
 * import type * as RpcClient from "effect/unstable/rpc/RpcClient";
 * import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
 * import * as Socket from "effect/unstable/socket/Socket";
 * import { CounterRpcs } from "./rpcs.ts";
 *
 * class CounterClient extends Context.Service<
 *   CounterClient,
 *   RpcClient.FromGroup<typeof CounterRpcs, RpcClientError>
 * >()("CounterClient") {}
 *
 * const ClientLive = RpcWebSocketClient.layer(
 *   CounterClient,
 *   CounterRpcs,
 *   "wss://example.com/counters/alice",
 * ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
 *
 * const program = Effect.gen(function* () {
 *   const counter = yield* CounterClient;
 *   return yield* counter.increment();
 * }).pipe(Effect.provide(ClientLive));
 * ```
 *
 * @layer
 * @provides service
 * @product Celld
 * @category Workers & Compute
 */
export const layer: typeof sharedLayer = sharedLayer;
