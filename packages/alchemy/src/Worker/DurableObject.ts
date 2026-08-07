/**
 * The portable **`Alchemy.DurableObject`** — the two-phase authoring
 * doctrine (init resolves shared dependencies; the returned inner Effect
 * runs per-instance with {@link DurableObjectState}) with the hosting
 * platform selected by the worker's target layer.
 *
 * The class is a pure tag; **the layer binds impl + hosting worker**
 * (`Counter.make(Api, impl)`). Building the layer inside the hosting
 * worker's impl registers the class; building it anywhere else yields a
 * remote stub speaking the alchemy fetch-RPC protocol against the worker's
 * gateway (engine-neutral at runtime — engines only differ in the
 * deploy-time caller binding).
 *
 * ```ts
 * export class Counter extends Alchemy.DurableObject<Counter, Shape>()("Counter") {}
 * export const CounterLive = Counter.make(Api, impl);
 * // callers: Effect.provide(CounterLive) — or Counter.client(Api) without the impl
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
import { WorkerTarget, findWorkerEngine } from "./Engine.ts";
import { Worker, isAlchemyWorker, type WorkerServices } from "./Worker.ts";

export type { DurableObjectStub };

export const DurableObjectTypeId = "Alchemy.DurableObject";
type TypeId = typeof DurableObjectTypeId;
const TypeId = DurableObjectTypeId;

/** The secret header the worker gateways check (engine-neutral). */
export const WORKER_SECRET_HEADER = "x-alchemy-fleet-secret";

/** The standard env keys a caller binding stores the connection under. */
export const workerConnectionKeys = (workerLogicalId: string) => ({
  urlKey: sanitizeKey(`ALCHEMY_WORKER_${workerLogicalId}_URL`),
  secretKey: sanitizeKey(`ALCHEMY_WORKER_${workerLogicalId}_SECRET`),
});

/**
 * A reference to the hosting {@link Worker} class: the class itself (a
 * Platform class is an Effect with a static `LogicalId`), or a thunk for
 * forward references / import cycles.
 */
export type WorkerRef =
  | Effect.Effect<any, any, any>
  | { readonly LogicalId: string }
  | (() => WorkerRef);

/** @internal */
export const resolveWorkerRef = (
  ref: WorkerRef,
  depth = 0,
): { LogicalId: string } => {
  if (
    ref !== null &&
    typeof (ref as { LogicalId?: unknown }).LogicalId === "string"
  ) {
    return ref as unknown as { LogicalId: string };
  }
  if (typeof ref === "function" && depth < 8) {
    return resolveWorkerRef((ref as () => WorkerRef)(), depth + 1);
  }
  throw new Error(
    "Invalid worker reference: pass the Alchemy.Worker class (or a thunk of it).",
  );
};

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
>()("Alchemy.DurableObjectScope") {}

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
     * whichever worker yields it; callers select the worker with
     * `.client(worker)`.
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
      /** Caller-side layer selecting the worker that hosts this class. */
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
       * The implementation layer, bound to the worker that hosts this
       * class. Provide it on the worker impl (hosts the class) and on
       * callers (resolves the remote stub); run the same class on a
       * different worker by making another layer.
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
       * A caller-only layer: selects the worker without carrying the
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
     * Hosting path — runs while the layer builds inside its worker's init.
     * Registers the class declaration through the binding channel and
     * returns the namespace handle over the native binding, using the
     * ambient target's engine-specific stub flavor.
     */
    const binding = () =>
      Effect.gen(function* () {
        const worker = yield* Worker;
        // The target is ambient inside the impl's provide chain (the DO
        // layer sits above it). Its absence here means the deployable
        // module provided no target — surfaced with guidance.
        const target = yield* Effect.serviceOption(WorkerTarget).pipe(
          Effect.map(Option.getOrUndefined),
        );

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
                `DurableObject '${namespace}' not found in the worker environment`,
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
            if (target === undefined) {
              throw new Error(
                `DurableObject '${namespace}' has no deployment target — provide one inside the worker impl's layer stack (e.g. Celld.Worker({ fleet, main })).`,
              );
            }
            return target.localDurableObject(
              native.getByName(name),
              namespace,
            ) as unknown as DurableObjectStub<any>;
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
        // registered on the worker.
        yield* constructor.pipe(
          Effect.provide(
            Layer.succeed(
              DurableObjectState,
              fromDurableObjectState({ storage: {} } as any),
            ),
          ),
        );
      }
      // `export` lives on the runtime context assigned onto the instance —
      // present at both plan and runtime, but not part of the resource type.
      yield* ((yield* Worker) as any).export(namespace, {
        kind: "durableObject",
        constructor,
        services: yield* Effect.context<never>(),
      } satisfies DurableObjectExport);
      return self;
    });

    /**
     * Remote-caller path — runs while the layer builds inside any non-worker
     * host. At plan, delegates the caller binding to the worker's engine; at
     * runtime, speaks the engine-neutral fetch-RPC protocol against the
     * standard connection env keys.
     */
    const remote = (workerRef: WorkerRef) =>
      Effect.gen(function* () {
        const workerClass = resolveWorkerRef(workerRef);
        const { urlKey, secretKey } = workerConnectionKeys(
          workerClass.LogicalId,
        );

        if (!globalThis.__ALCHEMY_RUNTIME__) {
          const host = yield* Binding.Host;
          if (
            host !== undefined &&
            typeof (host as any).bind === "function" &&
            !isAlchemyWorker(host)
          ) {
            // Yield the worker class: resource effects memoize by logical
            // id, so this references the stack's worker node and orders it
            // (and its infrastructure) ahead of this host in the graph.
            const worker = (yield* asEffect(workerClass as any)) as any;
            const engine = yield* findWorkerEngine(worker.Props?.target?.kind);
            const data = yield* engine.callerBinding({
              worker,
              host,
              urlKey,
              secretKey,
            });
            yield* (host as any)
              .bind`Allow(${host}, Alchemy.Worker.Call(${worker}))`(data);
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
                    `DurableObject '${namespace}' is not bound to this host — the worker connection env (${urlKey}) is missing`,
                  ),
                );
              }
              // The stub builds requests against its dummy default base —
              // graft the RPC path onto the worker's gateway URL.
              const rpcPath = new URL(request.url, "http://alchemy-rpc")
                .pathname;
              const target = request.pipe(
                HttpClientRequest.setUrl(
                  `${url}/${encodeURIComponent(namespace)}/${encodeURIComponent(instanceName)}${rpcPath}`,
                ),
                HttpClientRequest.setHeader(WORKER_SECRET_HEADER, secret),
              );
              // Bounded retry over transport errors and not-reached
              // gateway statuses (502/503/504). A 500 is NOT retried (the
              // request may have reached the cell) but still FAILS the
              // call — the RPC protocol answers 200 with an envelope, so
              // any other status is an infrastructure error, never a value.
              return yield* client.execute(target).pipe(
                Effect.flatMap((response) =>
                  response.status >= 300
                    ? response.text.pipe(
                        Effect.orElseSucceed(() => ""),
                        Effect.flatMap((body) =>
                          Effect.fail(
                            Object.assign(
                              new Error(
                                `worker gateway returned ${response.status}${body ? `: ${body.slice(0, 256)}` : ""}`,
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
                      "HTTP fetch pass-through on a remote stub is not supported yet — call RPC methods, or send requests to the worker URL directly",
                    ),
                  ),
              },
            }),
        } satisfies DurableObject<any>;
      });

    /**
     * The layer body: hosting when built inside the target worker, remote
     * everywhere else. The worker is a property of the LAYER — running the
     * class on a different worker is just a different layer.
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
        const workerClass = resolveWorkerRef(workerRef);
        if (isAlchemyWorker(host) && host.LogicalId === workerClass.LogicalId) {
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
      // Inline form: hosted by whichever worker yields the class; outside a
      // worker the caller selects the worker with `.client(worker)`.
      return class extends effectClass(
        Effect.gen(function* () {
          const host = yield* Binding.Host;
          if (isAlchemyWorker(host)) {
            return yield* makeHost(inlineImpl as any);
          }
          const provided = yield* Effect.serviceOption(tag);
          if (Option.isSome(provided)) {
            return provided.value;
          }
          return yield* Effect.die(
            new Error(
              `DurableObject '${namespace}' was yielded outside a worker ` +
                `without one selected — provide ${namespace}.client(worker).`,
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
