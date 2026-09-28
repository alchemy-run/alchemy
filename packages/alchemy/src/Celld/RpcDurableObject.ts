import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import type { HttpServerResponse } from "effect/unstable/http/HttpServerResponse";
import type { HttpServerError } from "effect/unstable/http/HttpServerError";
import type { Rpc, RpcGroup } from "effect/unstable/rpc";
import type * as RpcClient from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type { RuntimeContext } from "../RuntimeContext.ts";
import { effectClass } from "../Util/effect.ts";
import { bindEffectRpc, makeHandlers } from "../Workers/RpcDurableObject.ts";
import {
  DurableObject,
  type DurableObjectServices,
  type DurableObject as Namespace,
} from "./DurableObject.ts";
import type { DurableObjectState } from "./DurableObjectState.ts";
import * as RpcWebSocket from "./RpcWebSocket.ts";
import type { CelldWorker } from "./Worker.ts";

export interface RpcDurableObjectProps<Rpcs extends Rpc.Any> {
  /** The shared schema for HTTP and WebSocket calls. */
  readonly schema: RpcGroup.RpcGroup<Rpcs>;
}

export interface RpcDurableObject<Self, Rpcs extends Rpc.Any = Rpc.Any> {
  readonly kind: "Celld.DurableObject";
  readonly Type: "Celld.DurableObject";
  readonly name: string;
  readonly Self?: Self;
  /** Forward an HTTP request or WebSocket upgrade to a named instance. */
  readonly fetch: (
    id: string,
    request: HttpServerRequest,
  ) => Effect.Effect<HttpServerResponse, HttpServerError>;
  /** Select a typed HTTP client; each call acquires its native stub in the current request. */
  readonly getByName: (
    id: string,
  ) => Effect.Effect<
    RpcClient.RpcClient<Rpcs, RpcClientError>,
    never,
    Rpc.MiddlewareClient<Rpcs>
  >;
}

type Implementation<
  Rpcs extends Rpc.Any,
  Provided,
  InnerR,
  InitReq,
> = Effect.Effect<
  Effect.Effect<
    Layer.Layer<Rpc.ToHandler<Rpcs> | Provided, never, InnerR | RuntimeContext>,
    never,
    DurableObjectState | RuntimeContext | Scope.Scope
  >,
  never,
  InitReq
>;

type Requirements<Rpcs extends Rpc.Any, Provided, InnerR, InitReq> =
  | CelldWorker
  | Exclude<
      | InitReq
      | InnerR
      | Exclude<Rpc.Middleware<Rpcs>, Provided>
      | Rpc.ServicesServer<Rpcs>,
      DurableObjectServices | RuntimeContext
    >;

export interface RpcDurableObjectClass {
  <Self>(): {
    <Rpcs extends Rpc.Any>(
      name: string,
      props: RpcDurableObjectProps<Rpcs>,
    ): Effect.Effect<
      RpcDurableObject<Self, Rpcs>,
      never,
      Self | CelldWorker
    > & {
      new (_: never): { readonly "~alchemy/provider": "Celld" };
      make<Provided = never, InnerR = never, InitReq = never>(
        impl: Implementation<Rpcs, Provided, InnerR, InitReq>,
      ): Layer.Layer<
        Self,
        never,
        Requirements<Rpcs, Provided, InnerR, InitReq>
      >;
    };
    <Rpcs extends Rpc.Any, Provided = never, InnerR = never, InitReq = never>(
      name: string,
      props: RpcDurableObjectProps<Rpcs>,
      impl: Implementation<Rpcs, Provided, InnerR, InitReq>,
    ): Effect.Effect<
      RpcDurableObject<Self, Rpcs>,
      never,
      Requirements<Rpcs, Provided, InnerR, InitReq>
    > & {
      new (_: never): { readonly "~alchemy/provider": "Celld" };
    };
  };
  <Rpcs extends Rpc.Any, Provided = never, InnerR = never, InitReq = never>(
    name: string,
    props: RpcDurableObjectProps<Rpcs>,
    impl: Implementation<Rpcs, Provided, InnerR, InitReq>,
  ): Effect.Effect<
    RpcDurableObject<unknown, Rpcs>,
    never,
    Requirements<Rpcs, Provided, InnerR, InitReq>
  >;
}

/**
 * A schema-backed Celld Durable Object with HTTP and hibernatable WebSocket RPC.
 * Handlers are built once per native activation. Requests are never replayed
 * after activation loss; retained sockets with pending calls are reset.
 *
 * ### Declaring RPC Handlers
 * **Example:** A schema-backed object
 * ```typescript
 * class Room extends Celld.RpcDurableObject<Room>()("Room", { schema: RoomRpcs }) {}
 * const RoomLive = Room.make(Effect.succeed(Effect.succeed(
 *   RoomRpcs.toLayer({ greet: ({ name }) => Effect.succeed(`Hello, ${name}`) }),
 * )));
 * ```
 *
 * ### Forwarding a WebSocket
 * **Example:** Select the object before upgrading
 * ```typescript
 * const rooms = yield* Room;
 * return {
 *   fetch: Effect.gen(function* () {
 *     const request = yield* HttpServerRequest;
 *     return yield* rooms.fetch("lobby", request);
 *   }),
 * };
 * ```
 * Authenticate before forwarding. Celld publication still uses Application and
 * Fleet; this facade does not expose a separate public ingress.
 *
 * @resource
 * @product Celld
 */
export const RpcDurableObject: RpcDurableObjectClass = (
  ...args: any[]
): any => {
  if (args.length === 0) return build;
  return build(...(args as Parameters<typeof build>));
};

const wrap = <Rpcs extends Rpc.Any>(
  namespace: Namespace<any>,
  schema: RpcGroup.RpcGroup<Rpcs>,
): RpcDurableObject<any, Rpcs> => ({
  ...namespace,
  getByName: bindEffectRpc(namespace, schema).getByName,
  fetch: (id, request) => namespace.getByName(id).fetch(request),
});

const build = (
  name: string,
  props: RpcDurableObjectProps<any>,
  impl?: Effect.Effect<
    Effect.Effect<Layer.Layer<any, never, any>, never, any>,
    never,
    any
  >,
) => {
  const wrapImpl = (implementation: NonNullable<typeof impl>) =>
    implementation.pipe(
      Effect.map((inner) =>
        inner.pipe(
          Effect.flatMap((handlers) =>
            makeHandlers(props.schema, handlers, {
              transport: RpcWebSocket.make,
            }),
          ),
        ),
      ),
    );
  if (impl) {
    const underlying = (DurableObject as any)()(
      name,
      wrapImpl(impl),
    ) as Effect.Effect<Namespace<any>>;
    return effectClass(
      underlying.pipe(Effect.map((namespace) => wrap(namespace, props.schema))),
    );
  }
  const Underlying = (DurableObject as any)()(name);
  return class extends effectClass(
    (Underlying as Effect.Effect<Namespace<any>>).pipe(
      Effect.map((namespace) => wrap(namespace, props.schema)),
    ),
  ) {
    static make = (implementation: NonNullable<typeof impl>) =>
      Underlying.make(wrapImpl(implementation));
  };
};
