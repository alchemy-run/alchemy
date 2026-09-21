import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { Scope } from "effect/Scope";
import type { MainRpc, PlatformServices } from "../Platform.ts";
import { reviveRpcStubErrors, type RpcErrorClass } from "../Rpc.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import {
  durableObjectPlanContext,
  makeDurableObjectDeclaration,
  type DurableObjectBindingDeclaration,
  type DurableObjectStubLike,
  type DurableObjectStubOptions,
} from "../Workers/DurableObject.ts";
import type { WorkerEnvironment } from "../Workers/Worker.ts";
import { DurableObjectState } from "./DurableObjectState.ts";
import type { WebSocket } from "./WebSocket.ts";
import type { RivetWorker } from "./Worker.ts";

export interface DurableObject<Shape = unknown> {
  readonly kind: "Rivet.DurableObject";
  readonly Type: "Rivet.DurableObject";
  readonly name: string;
  getByName(name: string): DurableObjectStub<Shape>;
}

export type DurableObjectStub<Shape> = Shape;

/** Rivet actor lifecycle handlers; HTTP fetch belongs to the Worker. */
export interface DurableObjectShape {
  fetch?: never;
  /** Called with the already accepted native connection on connect and wake. */
  webSocketOpen?: (
    socket: WebSocket,
  ) => Effect.Effect<
    unknown,
    never,
    RuntimeContext | DurableObjectState | Scope
  >;
  alarm?: () => Effect.Effect<
    void,
    never,
    RuntimeContext | DurableObjectState | Scope
  >;
  webSocketMessage?: (
    socket: WebSocket,
    message: string | ArrayBuffer,
  ) => Effect.Effect<void, never, RuntimeContext | DurableObjectState | Scope>;
  webSocketClose?: (
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ) => Effect.Effect<void, never, RuntimeContext | DurableObjectState | Scope>;
  webSocketError?: (
    socket: WebSocket,
    error: unknown,
  ) => Effect.Effect<void, never, RuntimeContext | DurableObjectState | Scope>;
}

export interface DurableObjectProps {
  /** Tagged failures to reconstruct on the calling side of RPC. */
  errors?: ReadonlyArray<RpcErrorClass>;
}

export class DurableObjectScope extends Context.Service<
  DurableObjectScope,
  DurableObject
>()("Rivet.DurableObject") {}

export type DurableObjectServices =
  | DurableObjectState
  | DurableObjectScope
  | RivetWorker
  | WorkerEnvironment
  | PlatformServices;

export interface DurableObjectClass extends Effect.Effect<
  DurableObject,
  never,
  DurableObjectScope
> {
  <Self, Shape>(): {
    <Name extends string>(
      name: Name,
      props?: DurableObjectProps,
    ): Effect.Effect<DurableObject<Self>, never, RivetWorker | Self> & {
      new (_: never): Shape & {
        readonly "~alchemy/name": Name;
        readonly "~alchemy/provider": "Rivet";
      };
      make<Req = never>(
        impl: Effect.Effect<
          Effect.Effect<
            Shape & DurableObjectShape,
            never,
            RuntimeContext | DurableObjectState | Scope
          >,
          never,
          Req
        >,
      ): Layer.Layer<
        Self,
        never,
        RivetWorker | Exclude<Req, DurableObjectServices>
      >;
    };
  };
  <Self>(): {
    <
      Shape extends MainRpc<DurableObjectState> & DurableObjectShape,
      Req = never,
    >(
      name: string,
      impl: Effect.Effect<
        Effect.Effect<
          Shape,
          never,
          RuntimeContext | DurableObjectState | Scope
        >,
        never,
        Req
      >,
    ): Effect.Effect<
      DurableObject<Self>,
      never,
      RivetWorker | Exclude<Req, DurableObjectServices>
    > & {
      new (_: never): Shape & { readonly "~alchemy/provider": "Rivet" };
    };
  };
  <Shape, Req = never>(
    name: string,
    impl: Effect.Effect<Shape & DurableObjectShape, never, Req>,
  ): Effect.Effect<
    DurableObject<Shape>,
    never,
    RivetWorker | Exclude<Req, DurableObjectServices>
  >;
}

/**
 * A named Durable Object backed by a Rivet actor.
 *
 * ### Modular Objects
 * **Example:** Provider-owned state and implementation layer
 * ```typescript
 * class Counter extends Rivet.DurableObject<Counter, {
 *   get(): Effect.Effect<number | undefined, never, RuntimeContext>;
 * }>()("Counter") {}
 *
 * const CounterLive = Counter.make(Effect.gen(function* () {
 *   const state = yield* Rivet.DurableObjectState;
 *   return Effect.succeed({ get: () => state.storage.get<number>("count") });
 * }));
 * ```
 *
 * @resource
 * @product Rivet
 */
export const DurableObject: DurableObjectClass = makeDurableObjectDeclaration(
  DurableObjectScope,
  {
    kind: "Rivet.DurableObject",
    provider: "Rivet.Worker",
    planContext: durableObjectPlanContext(DurableObjectState, ["raw"]),
  },
);

/** @internal */
export const durableObjectBinding = (
  decl: DurableObjectBindingDeclaration,
) => ({
  durableObjects: [{ name: decl.name, className: decl.className }],
});

/** The runner environment already supplies a gateway-backed stub. @internal */
export const durableObjectStub = (
  nativeStub: DurableObjectStubLike,
  _namespace: string,
  options: DurableObjectStubOptions,
) => reviveRpcStubErrors(nativeStub, options.errors);
