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
import { DurableObjectState } from "./DurableObjectState.ts";
import { fromNativeFetcher, type NativeFetcher } from "./internal/Fetcher.ts";
import type { RivetWorker } from "./Worker.ts";

export interface DurableObject<Shape = unknown> {
  readonly kind: "Rivet.DurableObject";
  readonly Type: "Rivet.DurableObject";
  readonly name: string;
  getByName(name: string): DurableObjectStub<Shape>;
}

export type DurableObjectStub<Shape> = Shape & {
  fetch(
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, HttpServerError>;
};

/** The lifecycle handlers a Rivet Durable Object may implement. */
export interface DurableObjectShape {
  fetch?: HttpEffect<DurableObjectState | RuntimeContext>;
  alarm?: () => Effect.Effect<void, never, RuntimeContext | DurableObjectState | Scope>;
}

export interface DurableObjectProps {
  /** Tagged failures to reconstruct on the calling side of RPC. */
  errors?: ReadonlyArray<RpcErrorClass>;
}

export class DurableObjectScope extends Context.Service<DurableObjectScope, DurableObject>()(
  "Rivet.DurableObject",
) {}

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
      ): Layer.Layer<Self, never, RivetWorker | Exclude<Req, DurableObjectServices>>;
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
      RivetWorker | Exclude<Req, DurableObjectServices>
    > & {
      new (_: never): Shape & { readonly "~alchemy/provider": "Rivet" };
    };
  };
  <Shape, Req = never>(
    name: string,
    impl: Effect.Effect<Shape & DurableObjectShape, never, Req>,
  ): Effect.Effect<DurableObject<Shape>, never, RivetWorker | Exclude<Req, DurableObjectServices>>;
}

/**
 * A **Durable Object** hosted by a `Rivet.Worker`: a single-threaded,
 * stateful instance per name, with its own SQLite-backed storage on the
 * Rivet control plane. Each instance runs as a Rivet actor on the nodes of
 * the Worker that implements it, and other Workers reach it through the
 * control plane's gateway.
 *
 * The declaration and implementation follow `Cloudflare.DurableObject`:
 * declare the class and its RPC shape, implement it with `.make(...)`, and
 * provide the implementation on the hosting Worker.
 *
 * ### Declaring a Durable Object
 * **Example:** A counter with persistent storage
 * ```typescript
 * export class Counter extends Rivet.DurableObject<
 *   Counter,
 *   { increment: () => Effect.Effect<number, never, RuntimeContext> }
 * >()("Counter") {}
 *
 * export const CounterLive = Counter.make(
 *   Effect.gen(function* () {
 *     const state = yield* Rivet.DurableObjectState;
 *     return Effect.gen(function* () {
 *       return {
 *         increment: () =>
 *           Effect.gen(function* () {
 *             const count = ((yield* state.storage.get<number>("count")) ?? 0) + 1;
 *             yield* state.storage.put("count", count);
 *             return count;
 *           }),
 *       };
 *     });
 *   }),
 * );
 * ```
 *
 * ### Calling a Durable Object
 * **Example:** Address an instance by name from a Worker
 * ```typescript
 * const counters = yield* Counter;
 * const count = yield* counters.getByName("visits").increment();
 * ```
 *
 * @resource
 * @product Rivet
 */
export const DurableObject: DurableObjectClass = makeDurableObjectDeclaration(DurableObjectScope, {
  kind: "Rivet.DurableObject",
  provider: "Rivet.Worker",
  planContext: durableObjectPlanContext(DurableObjectState),
});

/** The binding a Worker records for each Durable Object class it hosts. @internal */
export const durableObjectBinding = (decl: DurableObjectBindingDeclaration) => ({
  durableObjects: [{ name: decl.name, className: decl.className }],
});

/** Rivet calls cross the gateway as fetch-RPC over the actor's `fetch`. @internal */
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
