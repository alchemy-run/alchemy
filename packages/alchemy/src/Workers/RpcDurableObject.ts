import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcSchema from "effect/unstable/rpc/RpcSchema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { Rpc, RpcGroup } from "effect/unstable/rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import type { HttpEffect } from "../Http.ts";
import type { Transport } from "./RpcWebSocket.ts";

/** The bridge closes this scope when an activation retires, not after construction. */
export class RpcActivationScope extends Context.Service<
  RpcActivationScope,
  Scope.Scope
>()("Alchemy.Workers.RpcActivationScope") {}

class RpcRequestLifetime extends RpcMiddleware.Service<RpcRequestLifetime>()(
  "Alchemy.Workers.RpcRequestLifetime",
) {}

export interface HandlerTransport<S, R = never> {
  readonly protocol: RpcServer.Protocol["Service"];
  readonly retire?: Effect.Effect<void>;
  readonly accept?: (socket: S) => Effect.Effect<boolean, never, R>;
  readonly trackRequest: Transport["trackRequest"];
  readonly webSocketMessage: (
    socket: S,
    message: string | ArrayBuffer,
  ) => Effect.Effect<void, never, R>;
  readonly webSocketClose: (socket: S) => Effect.Effect<void, never, R>;
  readonly webSocketError: (
    socket: S,
    error: unknown,
  ) => Effect.Effect<void, never, R>;
  readonly fetch?: HttpEffect;
}

/** Build handlers once per activation, sharing them across HTTP and WebSockets. */
export const makeHandlers = <Rpcs extends Rpc.Any, S, R, EventR = never>(
  schema: RpcGroup.RpcGroup<Rpcs>,
  handlers: Layer.Layer<any, never, any>,
  options: {
    readonly transport: Effect.Effect<
      HandlerTransport<S, EventR>,
      never,
      R | RpcSerialization.RpcSerialization
    >;
    /** Native streaming HTTP is unavailable on some hosts. */
    readonly http?: boolean;
  },
) =>
  Effect.gen(function* () {
    const activation = yield* Effect.serviceOption(RpcActivationScope);
    return yield* Effect.acquireUseRelease(
      Scope.make(),
      (instanceScope) =>
        Effect.gen(function* () {
          if (Option.isSome(activation)) {
            yield* Scope.addFinalizerExit(activation.value, (exit) =>
              Scope.close(instanceScope, exit),
            );
          }
          const memoMap = yield* Effect.sync(() => Layer.makeMemoMapUnsafe());
          const context = yield* Layer.buildWithMemoMap(
            handlers,
            memoMap,
            instanceScope,
          );
          const services = Layer.succeedContext(context);
          const transport = yield* options.transport.pipe(
            Effect.provide(RpcSerialization.layerJson),
          );
          const lifetime = Layer.succeed(
            RpcRequestLifetime,
            (effect, request) =>
              Effect.withFiber((fiber) =>
                transport
                  .trackRequest(request.client.id, request.requestId, fiber)
                  .pipe(Effect.andThen(effect)),
              ),
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
          if (transport.retire)
            yield* Scope.addFinalizer(instanceScope, transport.retire);
          const http = Effect.gen(function* () {
            const handler = yield* RpcServer.toHttpEffect(schema).pipe(
              Effect.provide(
                Layer.mergeAll(services, RpcSerialization.layerNdjson),
              ),
            );
            return yield* handler;
          });
          return {
            ...(transport.accept ? { webSocketOpen: transport.accept } : {}),
            webSocketMessage: transport.webSocketMessage,
            webSocketClose: transport.webSocketClose,
            webSocketError: transport.webSocketError,
            fetch: Effect.gen(function* () {
              const request = yield* HttpServerRequest;
              return yield* request.headers.upgrade?.toLowerCase() ===
              "websocket"
                ? (transport.fetch ??
                  Effect.succeed(HttpServerResponse.empty({ status: 426 })))
                : options.http === false
                  ? Effect.succeed(HttpServerResponse.empty({ status: 426 }))
                  : http;
            }),
          };
        }),
      (instanceScope, exit) =>
        Exit.isFailure(exit) ? Scope.close(instanceScope, exit) : Effect.void,
    );
  });

/** Typed namespace handles; native HTTP clients are acquired in each call's scope. */
export const bindEffectRpc = <Rpcs extends Rpc.Any, Options = never>(
  namespace: {
    readonly getByName: (
      id: string,
      options?: Options,
    ) => {
      readonly fetch: HttpClient.HttpClient["execute"];
    };
  },
  group: RpcGroup.RpcGroup<Rpcs>,
  settings?: {
    readonly serialization?: Layer.Layer<RpcSerialization.RpcSerialization>;
  },
): {
  readonly getByName: (
    id: string,
    options?: Options,
  ) => Effect.Effect<
    RpcClient.RpcClient<Rpcs, RpcClientError>,
    never,
    Rpc.MiddlewareClient<Rpcs>
  >;
} => ({
  getByName: Effect.fn(function* (id: string, options?: Options) {
    const context = yield* Effect.context<Rpc.MiddlewareClient<Rpcs>>();
    const middlewareKeys = new Set<string>();
    for (const rpc of group.requests.values()) {
      for (const middleware of (rpc as unknown as Rpc.AnyWithProps).middlewares)
        middlewareKeys.add(`${middleware.key}/Client`);
    }
    // Only middleware survives client acquisition; native stubs and scopes belong to calls.
    const middleware = Context.makeUnsafe<Rpc.MiddlewareClient<Rpcs>>(
      new Map(
        [...context.mapUnsafe].filter(([key]) => middlewareKeys.has(key)),
      ),
    );
    const acquire = Effect.withFiber((fiber) => {
      const httpClient = HttpClient.layerMergedContext(
        Effect.sync(() => {
          const stub = namespace.getByName(id, options);
          return HttpClient.make((request) => stub.fetch(request));
        }),
      );
      const protocol = RpcClient.layerProtocolHttp({
        url: "http://alchemy-rpc/",
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            settings?.serialization ?? RpcSerialization.layerNdjson,
            httpClient,
          ),
        ),
        Layer.provideMerge(
          Layer.succeedContext(Context.merge(middleware, fiber.context)),
        ),
      );
      return RpcClient.make(group).pipe(Effect.provide(protocol));
    });
    const methods = Object.fromEntries(
      [...group.requests].map(([tag, rpc]) => {
        const streaming = RpcSchema.isStreamSchema(
          (rpc as unknown as Rpc.AnyWithProps).successSchema,
        );
        return [
          tag,
          (input: unknown, callOptions?: { readonly asQueue?: boolean }) => {
            const call = acquire.pipe(
              Effect.map((client) =>
                (
                  client as Record<
                    string,
                    (input: unknown, options?: typeof callOptions) => unknown
                  >
                )[tag]!(input, callOptions),
              ),
            );
            if (streaming && !callOptions?.asQueue) {
              return Stream.unwrap(
                call as Effect.Effect<
                  Stream.Stream<unknown, unknown>,
                  never,
                  Scope.Scope
                >,
              );
            }
            const effect = Effect.flatten(
              call as Effect.Effect<
                Effect.Effect<unknown, unknown>,
                never,
                Scope.Scope
              >,
            );
            return streaming ? effect : Effect.scoped(effect);
          },
        ];
      }),
    );
    return methods as RpcClient.RpcClient<Rpcs, RpcClientError>;
  }),
});
