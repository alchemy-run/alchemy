/**
 * Durable Objects hosted on a Celld {@link Fleet}.
 *
 * The authoring DX mirrors `Cloudflare.DurableObject` — a two-phase Effect
 * (init resolves shared dependencies; the returned inner Effect runs
 * per-instance with {@link DurableObjectState}) whose returned object's
 * methods ARE the RPC surface. The class itself is a pure tag; **the fleet
 * is specified by the layer** (`Counter.make(Cells, impl)`), so the same
 * class runs against a different fleet by providing a different layer.
 *
 * The layer dual-dispatches on where it is built:
 *
 * - inside its fleet's impl, it registers the class + native binding and
 *   resolves the namespace over the fleet's own runtime;
 * - inside any other host (Lambda Function, ECS task, …), it registers the
 *   fleet connection (URL + secret env, plus the fleet host's
 *   network/credential fragment) on the host and resolves a typed remote
 *   stub speaking the alchemy RPC protocol over the fleet gateway.
 *
 * `yield* Counter` is identical everywhere — only the provided layer
 * decides hosting vs remote and which fleet.
 *
 * @section Defining a Durable Object
 * @example Inline
 * ```typescript
 * // fleet.ts — a single file: the fleet and an inline cell class
 * export class Cells extends Celld.Fleet<Cells>()("Cells") {}
 *
 * export class Counter extends Celld.DurableObject<Counter>()(
 *   "Counter",
 *   Effect.gen(function* () {
 *     const state = yield* Celld.DurableObjectState;
 *     return Effect.gen(function* () {
 *       const count = (yield* state.storage.get<number>("count")) ?? 0;
 *       return {
 *         increment: () =>
 *           Effect.gen(function* () {
 *             const next = count + 1;
 *             yield* state.storage.put("count", next);
 *             return next;
 *           }),
 *       };
 *     });
 *   }),
 * ) {}
 *
 * export default Cells.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* Counter;
 *     return {};
 *   }),
 * );
 * ```
 *
 * @example Tagged class with a separate layer
 * ```typescript
 * // cells.ts — tag-only fleet class
 * export class Cells extends Celld.Fleet<Cells>()("Cells") {}
 *
 * // counter.ts — the class is a pure tag; the layer binds impl + fleet
 * export class Counter extends Celld.DurableObject<Counter>()("Counter") {}
 *
 * export const CounterLive = Counter.make(
 *   Cells,
 *   Effect.gen(function* () {
 *     const state = yield* Celld.DurableObjectState;
 *     return Effect.gen(function* () {
 *       const count = (yield* state.storage.get<number>("count")) ?? 0;
 *       return {
 *         increment: () =>
 *           Effect.gen(function* () {
 *             const next = count + 1;
 *             yield* state.storage.put("count", next);
 *             return next;
 *           }),
 *         get: () => Effect.succeed(count),
 *       };
 *     });
 *   }),
 * );
 * ```
 *
 * @section Calling cells
 * @example From an AWS Lambda Function
 * ```typescript
 * export default class Api extends AWS.Lambda.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const counters = yield* Counter;
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const n = yield* counters.getByName("room-1").increment();
 *         return HttpServerResponse.text(String(n));
 *       }),
 *     };
 *   }).pipe(Effect.provide(CounterLive)),
 * ) {}
 * ```
 *
 * @example Bundle-lean callers
 * ```typescript
 * // `client` selects the fleet without pulling the implementation (and its
 * // dependencies) into the caller's bundle.
 * Effect.provide(Counter.client(Cells))
 * ```
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type { Scope } from "effect/Scope";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as Binding from "../Binding.ts";
import { ALCHEMY_PHASE } from "../Phase.ts";
import type { MainRpc, PlatformServices } from "../Platform.ts";
import { makeFetchRpcStub } from "../Rpc.ts";
import { CurrentRuntimeContext, sanitizeKey } from "../RuntimeContext.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import { effectClass, taggedFunction } from "../Util/effect.ts";
import { asEffect } from "../Util/types.ts";
import { fromCloudflareFetcher } from "../Cloudflare/Fetcher.ts";
import type {
  DurableObjectExport,
  DurableObjectShape,
  DurableObjectStub,
} from "../Cloudflare/Workers/DurableObject.ts";
import { WorkerEnvironment } from "../Cloudflare/Workers/Worker.ts";
import {
  DurableObjectState,
  fromDurableObjectState,
} from "./DurableObjectState.ts";
import { findFleetHost } from "./FleetHost.ts";
import {
  Worker,
  isCelldWorker,
  resolveClassRef,
  type ClassRef,
  type WorkerServices,
} from "./Worker.ts";
import { FLEET_SECRET_HEADER } from "./FleetGateway.ts";
import { DurableObjectTypeId } from "./FleetTypes.ts";

export type { DurableObjectStub };

type TypeId = DurableObjectTypeId;
const TypeId = DurableObjectTypeId;

/**
 * A reference to the {@link Worker} class a layer targets: the class itself
 * (a Platform class is an Effect with a static `LogicalId`), or a thunk for
 * forward references / import cycles.
 */
export type WorkerRef = ClassRef;

export interface DurableObjectProps {
  /**
   * Name of the exported Durable Object class.
   * @default the declaration name
   */
  className?: string;
}

export interface DurableObject<Shape = unknown> {
  Type: TypeId;
  LogicalId: string;
  name: string;
  /** Address the named instance — the stub's methods mirror the Shape. */
  getByName: (name: string) => DurableObjectStub<Shape>;
}

export class DurableObjectScope extends Context.Service<
  DurableObjectScope,
  DurableObject<any>
>()("Celld.DurableObjectScope") {}

/** Services available to a Durable Object impl's init effect. */
export type DurableObjectServices =
  | DurableObject
  | DurableObjectScope
  | DurableObjectState
  | WorkerEnvironment
  | WorkerServices
  | PlatformServices;

export interface DurableObjectClass {
  <Self, Shape = never>(): {
    /**
     * Inline form: the implementation is coupled to the class. Hosted by
     * whichever fleet yields it; callers select the fleet with
     * `.client(fleet)`.
     */
    <
      ImplShape extends MainRpc<DurableObjectState>,
      Req extends DurableObjectServices = never,
    >(
      name: string,
      impl: Effect.Effect<
        Effect.Effect<
          ImplShape,
          never,
          RuntimeContext | DurableObjectState | Scope
        >,
        never,
        Req
      >,
    ): Effect.Effect<
      DurableObject<[Shape] extends [never] ? ImplShape : Shape>,
      never,
      never
    > & {
      new (_: never): [Shape] extends [never] ? ImplShape : Shape;
      /** Caller-side layer selecting the fleet that hosts this class. */
      client(worker: WorkerRef): Layer.Layer<Self>;
    };
    <Name extends string>(
      name: Name,
      props?: DurableObjectProps,
    ): Effect.Effect<DurableObject<Self>, never, Self> & {
      new (_: never): Shape & {
        /** @internal */
        "~alchemy/name": Name;
      };
      /**
       * The implementation layer, bound to the fleet that hosts this class.
       * Provide it on the fleet's impl (hosts the class) and on callers
       * (resolves the remote stub); run the same class on a different fleet
       * by making another layer.
       */
      make<Req = never>(
        worker: WorkerRef,
        impl: Effect.Effect<
          Effect.Effect<
            [Shape] extends [never] ? MainRpc<DurableObjectState> : Shape,
            never,
            RuntimeContext | DurableObjectState | Scope
          >,
          never,
          DurableObjectServices | Req
        >,
      ): Layer.Layer<Self, never, Exclude<Req, DurableObjectServices>>;
      /**
       * A caller-only layer: selects the fleet without carrying the
       * implementation into the caller's bundle. Never hosts.
       */
      client(worker: WorkerRef): Layer.Layer<Self>;
    };
  };
}

/** Unwrap a possibly-`Redacted` env value to its raw string. */
const rawValue = (value: unknown): string | undefined =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? String(Redacted.value(value))
      : String(value);

export const DurableObject: DurableObjectClass = taggedFunction(
  DurableObjectScope,
  function (
    ...args:
      | []
      | [name: string, props?: DurableObjectProps | Effect.Effect<any>]
  ) {
    if (args.length === 0) {
      return (name: string, props?: DurableObjectProps | Effect.Effect<any>) =>
        (DurableObject as any)(name, props);
    }
    const namespace = args[0];
    const inlineImpl = Effect.isEffect(args[1])
      ? (args[1] as Effect.Effect<any>)
      : undefined;
    const props =
      inlineImpl === undefined ? (args[1] as DurableObjectProps) : undefined;
    const className = props?.className ?? namespace;
    const tag = Context.Service(namespace) as Effect.Effect<any, never, any> &
      Context.Service<any, any>;

    /**
     * Hosting path — runs while the layer builds inside its fleet's init.
     * Registers the class declaration through the binding channel and
     * returns the namespace handle over the native binding, speaking the
     * alchemy RPC protocol over the instance's `fetch` (streaming-safe on
     * celld).
     */
    const binding = () =>
      Effect.gen(function* () {
        const worker = yield* Worker;

        yield* worker.bind`${namespace}`({
          durableObjects: [{ name: namespace, className }],
        });

        const native = yield* Effect.all([
          Effect.serviceOption(WorkerEnvironment).pipe(
            Effect.map(Option.getOrUndefined),
          ),
          ALCHEMY_PHASE,
        ]).pipe(
          Effect.flatMap(([env, phase]) => {
            if (env === undefined || phase === "plan") {
              return Effect.succeed(undefined);
            }
            const ns = env[namespace];
            if (ns && typeof ns.getByName === "function") {
              return Effect.succeed(ns);
            }
            return Effect.die(
              new Error(
                `DurableObject '${namespace}' not found in the fleet environment`,
              ),
            );
          }),
        );

        return {
          Type: TypeId,
          LogicalId: namespace,
          name: namespace,
          getByName: (name: string) => {
            if (native === undefined) {
              throw new Error(
                `DurableObject '${namespace}' can only be called at runtime`,
              );
            }
            const fetcher = fromCloudflareFetcher(native.getByName(name));
            return makeFetchRpcStub<DurableObjectStub<any>>({
              fetch: (request) => fetcher.fetch(request),
              base: {
                fetch: (request: unknown) => fetcher.fetch(request as any),
              },
            });
          },
        } satisfies DurableObject<any>;
      });

    const makeHost = Effect.fn(function* (
      impl: Effect.Effect<
        Effect.Effect<DurableObjectShape>,
        never,
        DurableObjectState
      >,
    ) {
      const self = yield* binding();
      const phase = yield* ALCHEMY_PHASE;
      const constructor = impl.pipe(
        Effect.provide(Layer.succeed(DurableObjectScope, self as any)),
      );
      if (phase === "plan") {
        // Evaluate the init phase with a mock state at plan time so
        // transitive bindings the object depends on are discovered and
        // registered on the fleet.
        yield* constructor.pipe(
          Effect.provide(
            Layer.succeed(
              DurableObjectState,
              fromDurableObjectState({ storage: {} } as any),
            ),
          ),
        );
      }
      yield* (yield* Worker).export(namespace, {
        kind: "durableObject",
        constructor,
        services: yield* Effect.context<never>(),
      } satisfies DurableObjectExport);
      return self;
    });

    /**
     * Remote-caller path — runs while the layer builds inside any non-fleet
     * host. Registers the fleet connection env (+ the fleet host's caller
     * fragment) through the binding channel and returns a stub over the
     * fleet gateway.
     */
    const remote = (workerRef: WorkerRef) =>
      Effect.gen(function* () {
        const workerClass = resolveClassRef(workerRef);
        const urlKey = sanitizeKey(`CELLD_${workerClass.LogicalId}_URL`);
        const secretKey = sanitizeKey(`CELLD_${workerClass.LogicalId}_SECRET`);

        if (!globalThis.__ALCHEMY_RUNTIME__) {
          const host = yield* Binding.Host;
          if (
            host !== undefined &&
            typeof (host as any).bind === "function" &&
            !isCelldWorker(host)
          ) {
            // Yield the worker class: resource effects memoize by logical id,
            // so this references the stack's worker node and orders the
            // worker (and its fleet) ahead of this host in the graph.
            const worker = (yield* asEffect(workerClass as any)) as any;
            const adapter = yield* findFleetHost(worker.Props?.hostKind);
            const fragment = yield* adapter.callerBinding({
              target: worker,
              host,
            });
            yield* (host as any).bind`Allow(${host}, Celld.Call(${worker}))`({
              ...fragment,
              env: {
                ...(fragment as { env?: Record<string, unknown> }).env,
                [urlKey]: worker.fleetUrl,
                [secretKey]: worker.fleetSecret,
              },
            });
          }
        }

        const client = yield* Effect.serviceOption(HttpClient.HttpClient).pipe(
          Effect.map(Option.getOrUndefined),
        );
        const ctx = yield* CurrentRuntimeContext;

        const call =
          (instanceName: string) =>
          (request: HttpClientRequest.HttpClientRequest) =>
            Effect.gen(function* () {
              if (client === undefined || ctx === undefined) {
                return yield* Effect.die(
                  new Error(
                    `DurableObject '${namespace}' can only be called at runtime inside a deployed host`,
                  ),
                );
              }
              const url = rawValue(yield* ctx.get(urlKey));
              const secret = rawValue(yield* ctx.get(secretKey));
              if (url === undefined || secret === undefined) {
                return yield* Effect.die(
                  new Error(
                    `DurableObject '${namespace}' is not bound to this host — the fleet connection env (${urlKey}) is missing`,
                  ),
                );
              }
              const target = request.pipe(
                HttpClientRequest.prependUrl(
                  `${url}/${encodeURIComponent(namespace)}/${encodeURIComponent(instanceName)}`,
                ),
                HttpClientRequest.setHeader(FLEET_SECRET_HEADER, secret),
              );
              // Bounded retry over transport errors and not-reached
              // gateway statuses (502/503/504) — fleet nodes restart on
              // deploys and DNS may race task churn. A 500 is NOT retried
              // (the request may have reached the cell) but still FAILS the
              // call — the RPC protocol answers 200 with an envelope, so any
              // other status is an infrastructure error, never a value.
              return yield* client.execute(target).pipe(
                Effect.flatMap((response) =>
                  response.status >= 300
                    ? response.text.pipe(
                        Effect.orElseSucceed(() => ""),
                        Effect.flatMap((body) =>
                          Effect.fail(
                            Object.assign(
                              new Error(
                                `fleet gateway returned ${response.status}${body ? `: ${body.slice(0, 256)}` : ""}`,
                              ),
                              { status: response.status },
                            ),
                          ),
                        ),
                      )
                    : Effect.succeed(response),
                ),
                Effect.retry({
                  while: (error): boolean =>
                    !(
                      typeof error === "object" &&
                      error !== null &&
                      "status" in error
                    ) ||
                    (error as { status: number }).status === 502 ||
                    (error as { status: number }).status === 503 ||
                    (error as { status: number }).status === 504,
                  schedule: Schedule.exponential("500 millis"),
                  times: 5,
                }),
              );
            });

        return {
          Type: TypeId,
          LogicalId: namespace,
          name: namespace,
          getByName: (name: string) =>
            makeFetchRpcStub<DurableObjectStub<any>>({
              fetch: call(name),
              base: {
                fetch: () =>
                  Effect.die(
                    new Error(
                      "HTTP fetch pass-through on a remote Celld stub is not supported yet — call RPC methods, or send requests to the fleet URL directly",
                    ),
                  ),
              },
            }),
        } satisfies DurableObject<any>;
      });

    /**
     * The layer body: hosting when built inside the target fleet, remote
     * everywhere else. The fleet is a property of the LAYER — running the
     * class on a different fleet is just a different layer.
     */
    const dispatch = (
      workerRef: WorkerRef,
      impl:
        | Effect.Effect<
            Effect.Effect<DurableObjectShape>,
            never,
            DurableObjectState
          >
        | undefined,
    ) =>
      Effect.gen(function* () {
        const host = yield* Binding.Host;
        const workerClass = resolveClassRef(workerRef);
        if (isCelldWorker(host) && host.LogicalId === workerClass.LogicalId) {
          if (impl === undefined) {
            return yield* Effect.die(
              new Error(
                `DurableObject '${namespace}' is hosted by worker '${host.LogicalId}' but only a client layer was provided — provide ${namespace}.make(${workerClass.LogicalId}, impl) on the worker impl.`,
              ),
            );
          }
          return yield* makeHost(impl);
        }
        return yield* remote(workerRef);
      });

    if (inlineImpl !== undefined) {
      // Inline form: hosted by whichever fleet yields the class; outside a
      // fleet the caller selects the fleet with `.client(fleet)`.
      return class extends effectClass(
        Effect.gen(function* () {
          const host = yield* Binding.Host;
          if (isCelldWorker(host)) {
            return yield* makeHost(inlineImpl as any);
          }
          const provided = yield* Effect.serviceOption(tag);
          if (Option.isSome(provided)) {
            return provided.value;
          }
          return yield* Effect.die(
            new Error(
              `DurableObject '${namespace}' was yielded outside a Celld ` +
                `Worker without one selected — provide ${namespace}.client(worker).`,
            ),
          );
        }),
      ) {
        static client = (worker: WorkerRef) =>
          Layer.effect(tag, dispatch(worker, inlineImpl as any));
      };
    }

    return class extends effectClass(tag as Effect.Effect<any, never, any>) {
      static make = <Req = never>(
        worker: WorkerRef,
        impl: Effect.Effect<
          Effect.Effect<DurableObjectShape, never, DurableObjectState | Req>
        >,
      ) => Layer.effect(tag, dispatch(worker, impl as any));

      static client = (worker: WorkerRef) =>
        Layer.effect(tag, dispatch(worker, undefined));
    };
  },
) as any;
