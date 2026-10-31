/**
 * The server half of `RpcDurableObject`, shared by every engine whose
 * objects follow the Workers API (Cloudflare today).
 *
 * @internal
 */
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import type { RpcGroup } from "effect/rpc";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Scope from "effect/Scope";
import { RuntimeContext } from "../../RuntimeContext.ts";
import * as RpcWebSocket from "./RpcWebSocket.ts";

/**
 * Wrap an `RpcDurableObject` implementation: an inner Effect returning a
 * handlers Layer becomes the object's RPC server — HTTP for plain requests,
 * the hibernatable WebSocket transport for upgrades. Any other value is
 * served as the object's `fetch`.
 */
export const wrapRpcDurableObjectImpl = <I>(
  State: Context.Key<I, RpcWebSocket.RpcWebSocketState>,
  impl: Effect.Effect<Effect.Effect<any>>,
  schema: RpcGroup.RpcGroup<any>,
) =>
  impl.pipe(
    Effect.map((inner) =>
      inner.pipe(
        Effect.flatMap((value) => {
          if (Layer.isLayer(value)) {
            // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- untyped impl value; layer requirements are provided by the DO bridge
            return makeHandlers(State, schema, value as Layer.Layer<any, never, any>);
          }
          return Effect.succeed({ fetch: value });
        }),
      ),
    ),
  ) as Effect.Effect<Effect.Effect<any>>;

class RpcRequestLifetime extends RpcMiddleware.Service<RpcRequestLifetime>()(
  "Cloudflare.RpcDurableObject.RequestLifetime",
) {}

const makeHandlers = Effect.fn(function* <I>(
  State: Context.Key<I, RpcWebSocket.RpcWebSocketState>,
  schema: RpcGroup.RpcGroup<any>,
  handlers: Layer.Layer<any, never, any>,
) {
  // The protocol outlives the constructor's temporary layer scope.
  return yield* Effect.acquireUseRelease(
    Scope.make(),
    (instanceScope) =>
      Effect.gen(function* () {
        const memoMap = Layer.makeMemoMapUnsafe();
        const context = yield* Layer.buildWithMemoMap(handlers, memoMap, instanceScope);
        const services = Layer.succeedContext(context);
        const http = Effect.gen(function* () {
          const handler = yield* RpcServer.toHttpEffect(schema).pipe(
            Effect.provide(Layer.mergeAll(services, RpcSerialization.layerNdjson)),
          );
          return yield* handler;
        });
        const state = yield* State;
        const runtime = yield* RuntimeContext;
        const lifetime = Layer.succeed(RpcRequestLifetime, (effect) =>
          Effect.withFiber((fiber) =>
            // RpcServer sends Exit before finalization and drops sends after disconnect.
            state
              .waitUntil(Fiber.await(fiber))
              .pipe(Effect.provideService(RuntimeContext, runtime), Effect.andThen(effect)),
          ),
        );
        const transport = yield* RpcWebSocket.make(state).pipe(
          Effect.provide(RpcSerialization.layerJson),
        );
        yield* Layer.buildWithMemoMap(
          RpcServer.layer(schema.middleware(RpcRequestLifetime)).pipe(
            Layer.provide(
              Layer.mergeAll(
                services,
                lifetime,
                Layer.succeed(RpcServer.Protocol, transport.protocol),
              ),
            ),
          ),
          memoMap,
          instanceScope,
        );
        return {
          webSocketMessage: transport.webSocketMessage,
          webSocketClose: transport.webSocketClose,
          webSocketError: transport.webSocketError,
          fetch: Effect.gen(function* () {
            const request = yield* HttpServerRequest;
            return yield* request.headers.upgrade?.toLowerCase() === "websocket"
              ? transport.fetch
              : http;
          }),
        };
      }),
    (instanceScope, exit) =>
      Exit.isFailure(exit) ? Scope.close(instanceScope, exit) : Effect.void,
  );
});
