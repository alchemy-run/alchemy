import type { HttpEffect } from "alchemy/Http";
import type { MainRpc, PlatformServices } from "alchemy/Platform";
import { makeFetchRpcStub, reviveRpcStubErrors, type RpcErrorClass } from "alchemy/Rpc";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import {
  durableObjectPlanContext,
  makeDurableObjectDeclaration,
  type DurableObjectBindingDeclaration,
  type DurableObjectStubLike,
  type DurableObjectStubOptions,
} from "alchemy/Workers/DurableObject";
import type { WorkerEnvironment } from "alchemy/Workers/Worker";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { HttpServerError } from "effect/http/HttpServerError";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as Layer from "effect/Layer";
import type { Scope } from "effect/Scope";
import { DurableObjectState, type AlarmInvocationInfo } from "./DurableObjectState.ts";
import { fromNativeFetcher, type NativeFetcher } from "./Fetcher.ts";
import type { WebSocket } from "./WebSocket.ts";
import type { CelldWorker } from "./Worker.ts";

export interface DurableObject<Shape = unknown> {
  readonly kind: "Celld.DurableObject";
  readonly Type: "Celld.DurableObject";
  readonly name: string;
  getByName(name: string): DurableObjectStub<Shape>;
}

export type DurableObjectStub<Shape> = Shape & {
  fetch(
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpServerError>;
};

export interface DurableObjectShape {
  fetch?: HttpEffect<DurableObjectState | RuntimeContext>;
  alarm?: (
    info?: AlarmInvocationInfo,
  ) => Effect.Effect<void, never, RuntimeContext | DurableObjectState | Scope>;
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

export class DurableObjectScope extends Context.Service<DurableObjectScope, DurableObject>()(
  "Celld.DurableObject",
) {}

export type DurableObjectServices =
  | DurableObjectState
  | DurableObjectScope
  | CelldWorker
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
    ): Effect.Effect<DurableObject<Self>, never, CelldWorker | Self> & {
      new (_: never): Shape & {
        readonly "~alchemy/name": Name;
        readonly "~alchemy/provider": "Celld";
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
      ): Layer.Layer<Self, never, CelldWorker | Exclude<Req, DurableObjectServices>>;
    };
  };
  <Self>(): {
    <Shape extends MainRpc<DurableObjectState> & DurableObjectShape, Req = never>(
      name: string,
      impl: Effect.Effect<
        Effect.Effect<Shape, never, RuntimeContext | DurableObjectState | Scope>,
        never,
        Req
      >,
    ): Effect.Effect<
      DurableObject<Self>,
      never,
      CelldWorker | Exclude<Req, DurableObjectServices>
    > & {
      new (_: never): Shape & { readonly "~alchemy/provider": "Celld" };
    };
  };
  <Shape, Req = never>(
    name: string,
    impl: Effect.Effect<Shape & DurableObjectShape, never, Req>,
  ): Effect.Effect<DurableObject<Shape>, never, CelldWorker | Exclude<Req, DurableObjectServices>>;
}

/**
 * A named Durable Object hosted by a Celld Worker.
 *
 * ### Modular Objects
 * **Example:** Provider-owned state and implementation layer
 * ```typescript
 * class Counter extends Celld.DurableObject<Counter, {
 *   get(): Effect.Effect<number | undefined, never, RuntimeContext>;
 * }>()("Counter") {}
 *
 * const CounterLive = Counter.make(Effect.gen(function* () {
 *   const state = yield* Celld.DurableObjectState;
 *   return Effect.succeed({ get: () => state.storage.get<number>("count") });
 * }));
 * ```
 *
 * @resource
 * @product Celld
 */
export const DurableObject: DurableObjectClass = makeDurableObjectDeclaration(DurableObjectScope, {
  kind: "Celld.DurableObject",
  provider: "Celld.Worker",
  planContext: durableObjectPlanContext(DurableObjectState),
});

/** @internal */
export const durableObjectBinding = (decl: DurableObjectBindingDeclaration) => ({
  durableObjects: [{ name: decl.name, className: decl.className }],
});

/** Celld uses fetch-RPC rather than workerd JSRPC. @internal */
export const durableObjectStub = (
  nativeStub: DurableObjectStubLike,
  _namespace: string,
  options: DurableObjectStubOptions,
) => {
  const fetcher = fromNativeFetcher(nativeStub as NativeFetcher);
  return reviveRpcStubErrors(
    makeFetchRpcStub<Record<string, unknown>>({
      // Stub methods only run inside a deployed Worker, where the bridge
      // provides the RuntimeContext the native fetch is colored with.
      fetch: (request: HttpClientRequest.HttpClientRequest) =>
        // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- erases RuntimeContext, which the bridge provides at call time
        fetcher.fetch(request) as Effect.Effect<HttpClientResponse.HttpClientResponse, unknown>,
      base: {
        fetch: (request: HttpServerRequest.HttpServerRequest) => fetcher.fetch(request),
      },
    }),
    options.errors,
  );
};
