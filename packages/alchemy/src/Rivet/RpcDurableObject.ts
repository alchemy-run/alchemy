import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { Rpc, RpcGroup } from "effect/unstable/rpc";
import type * as RpcClient from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import * as Socket from "effect/unstable/socket/Socket";
import type { RuntimeContext } from "../RuntimeContext.ts";
import { effectClass, taggedFunction } from "../Util/effect.ts";
import { makeHandlers } from "../Workers/RpcDurableObject.ts";
import * as RpcWebSocketClient from "../Workers/RpcWebSocketClient.ts";
import {
  DurableObject,
  type DurableObjectServices,
  type DurableObject as Namespace,
} from "./DurableObject.ts";
import { RivetRpcWebSocketUrl } from "./Gateway.ts";
import * as RpcWebSocket from "./RpcWebSocket.ts";
import { bindWorker, type RivetWorker } from "./Worker.ts";

export interface RpcDurableObjectProps<Rpcs extends Rpc.Any> {
  /** Shared schema for typed requests, errors and incremental stream items. */
  readonly schema: RpcGroup.RpcGroup<Rpcs>;
}

export interface RpcDurableObject<Self, Rpcs extends Rpc.Any = Rpc.Any> {
  /** The provider-owned namespace kind. */
  readonly kind: "Rivet.RpcDurableObject";
  /** Registered native actor name. */
  readonly name: string;
  /** @internal */
  readonly Self?: Self;
  /** Acquire a private gateway WebSocket for the caller's Scope; calls are never replayed. */
  readonly getByName: (
    name: string,
  ) => Effect.Effect<
    RpcClient.RpcClient<Rpcs, RpcClientError>,
    never,
    Scope.Scope | Rpc.MiddlewareClient<Rpcs> | Socket.WebSocketConstructor
  >;
}

type Implementation<
  Rpcs extends Rpc.Any,
  Provided,
  Inner,
  Outer,
> = Effect.Effect<
  Effect.Effect<
    Layer.Layer<Rpc.ToHandler<Rpcs> | Provided, never, Inner>,
    never,
    DurableObjectServices | RpcDurableObjectScope | RuntimeContext | Scope.Scope
  >,
  never,
  Outer
>;

type Requirements<Rpcs extends Rpc.Any, Provided, Inner, Outer> =
  | RivetWorker
  | Exclude<
      | Outer
      | Inner
      | Exclude<Rpc.Middleware<Rpcs>, Provided>
      | Rpc.ServicesServer<Rpcs>,
      | DurableObjectServices
      | RpcDurableObjectScope
      | RuntimeContext
      | Scope.Scope
    >;

export class RpcDurableObjectScope extends Context.Service<
  RpcDurableObjectScope,
  RpcDurableObject<unknown>
>()("Rivet.RpcDurableObject") {}

export interface RpcDurableObjectClass extends Effect.Effect<
  RpcDurableObject<unknown>,
  never,
  RpcDurableObjectScope
> {
  <Self>(): {
    <Rpcs extends Rpc.Any>(
      name: string,
      props: RpcDurableObjectProps<Rpcs>,
    ): Effect.Effect<
      RpcDurableObject<Self, Rpcs>,
      never,
      RivetWorker | Self
    > & {
      new (_: never): {};
      /** Bind a deployed caller to the host's private network and schema namespace. */
      from<Req>(
        worker: Effect.Effect<RivetWorker, never, Req>,
      ): Effect.Effect<RpcDurableObject<Self, Rpcs>, never, Req>;
      make<Provided = never, Inner = never, Outer = never>(
        impl: Implementation<Rpcs, Provided, Inner, Outer>,
      ): Layer.Layer<Self, never, Requirements<Rpcs, Provided, Inner, Outer>>;
    };
    <Rpcs extends Rpc.Any, Provided = never, Inner = never, Outer = never>(
      name: string,
      props: RpcDurableObjectProps<Rpcs>,
      impl: Implementation<Rpcs, Provided, Inner, Outer>,
    ): Effect.Effect<
      RpcDurableObject<Self, Rpcs>,
      never,
      Requirements<Rpcs, Provided, Inner, Outer>
    > & { new (_: never): {} };
  };
}

const bind = <Rpcs extends Rpc.Any>(
  namespace: Pick<Namespace, "name" | "getByName">,
  schema: RpcGroup.RpcGroup<Rpcs>,
): RpcDurableObject<unknown, Rpcs> => ({
  kind: "Rivet.RpcDurableObject",
  name: namespace.name,
  getByName: (name) =>
    Effect.gen(function* () {
      const stub = namespace.getByName(name) as {
        readonly [RivetRpcWebSocketUrl]: string;
      };
      const Client = Context.Service<RpcClient.RpcClient<Rpcs, RpcClientError>>(
        `Rivet.RpcClient.${namespace.name}`,
      );
      const context = yield* Layer.build(
        RpcWebSocketClient.layer(Client, schema, stub[RivetRpcWebSocketUrl], {
          socket: { protocols: ["rivet", "rivet_encoding.bare"] },
        }),
      );
      return Context.get(context, Client);
    }),
});

/**
 * A provider-owned schema RPC actor using native, hibernatable WebSockets.
 * Streams are sent incrementally, unlike the collected class-method action
 * transport. The engine remains private; browser callers need an authenticated,
 * application-owned WebSocket ingress, not a Lambda Function URL.
 *
 * RivetKit 2.3.10 prevents automatic idle sleep while raw sockets remain open.
 * Connections recover after explicit native sleep; the adapter does not force
 * sleep to bypass native activity tracking.
 *
 * ### Schema and Handler Layer
 * **Example:** Declare a room and provide its implementation on the Rivet Worker
 * ```typescript
 * class Room extends Rivet.RpcDurableObject<Room>()("Room", { schema: RoomRpcs }) {}
 * const RoomLive = Room.make(Effect.succeed(Effect.succeed(RoomRpcs.toLayer({
 *   greet: ({ name }) => Effect.succeed(`Hello, ${name}`),
 *   numbers: ({ count }) => Stream.range(1, count),
 * }))));
 * ```
 *
 * ### Scoped Private Caller
 * **Example:** Keep the connection only for the caller's request
 * ```typescript
 * const room = yield* rooms.getByName("lobby");
 * const greeting = yield* room.greet({ name: "Sam" });
 * ```
 * Provide a WebSocketConstructor and run the caller inside Effect.scoped.
 *
 * @resource
 * @product Rivet
 */
export const RpcDurableObject: RpcDurableObjectClass = taggedFunction(
  RpcDurableObjectScope,
  () =>
    (
      name: string,
      props: RpcDurableObjectProps<any>,
      implementation?: Implementation<any, any, any, any>,
    ): any => {
      const Decl = DurableObject<any, any>()(name);
      const tag = Context.Service(`Rivet.RpcDurableObject.${name}`);
      const make = (impl: Implementation<any, any, any, any>) => {
        const constructor = Effect.gen(function* () {
          const namespace = yield* DurableObject;
          const self = Layer.succeed(
            RpcDurableObjectScope,
            bind(namespace, props.schema),
          );
          const inner = yield* impl.pipe(Effect.provide(self));
          return inner.pipe(
            Effect.flatMap((handlers) =>
              makeHandlers(props.schema, handlers.pipe(Layer.provide(self)), {
                http: false,
                transport: RpcWebSocket.make,
              }),
            ),
            Effect.map(({ fetch: _, ...events }) => events),
            Effect.provide(self),
          );
        });
        return Layer.effect(
          tag,
          Decl.pipe(Effect.map((namespace) => bind(namespace, props.schema))),
        ).pipe(Layer.provide(Decl.make(constructor)));
      };
      const declaration = class extends effectClass(
        tag as Effect.Effect<any, never, any>,
      ) {
        static make = make;
        static from = (worker: Effect.Effect<RivetWorker, never, any>) =>
          bindWorker(worker).pipe(
            Effect.map((client) =>
              bind({ name, ...client.durableObject(name) }, props.schema),
            ),
          );
      };
      return implementation === undefined
        ? declaration
        : effectClass(declaration.pipe(Effect.provide(make(implementation))));
    },
) as unknown as RpcDurableObjectClass;
