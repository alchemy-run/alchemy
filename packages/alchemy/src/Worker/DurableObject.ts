/**
 * The portable **`Alchemy.DurableObject`** — the two-phase authoring
 * doctrine (init resolves shared dependencies; the returned inner Effect
 * runs per-instance with {@link DurableObjectState}) with the hosting
 * platform selected by the worker's target layer.
 *
 * The class is a pure tag; **the layer is cloud- and worker-free**
 * (`Counter.make(impl)`). Building the layer inside a hosting worker's
 * impl registers the class on that worker; building it anywhere else
 * yields a remote stub, with the hosting worker supplied by a `.ref`
 * layer (`CounterLive.pipe(Layer.provide(Celld.Worker.ref(Api)))`) —
 * engine-neutral at runtime; engines only differ in the deploy-time
 * caller binding.
 *
 * ```ts
 * export class Counter extends Alchemy.DurableObject<Counter, Shape>()("Counter") {}
 * export const CounterLive = Counter.make(impl);
 * // hosting:  Cloudflare.Worker(Api, { main }, ApiLive)  // ApiLive provides CounterLive
 * // callers:  Effect.provide(CounterLive.pipe(Layer.provide(Cloudflare.Worker.ref(Api))))
 * ```
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { Scope } from "effect/Scope";
import * as Binding from "../Binding.ts";
import { ALCHEMY_PHASE } from "../Phase.ts";
import type { MainRpc, PlatformServices } from "../Platform.ts";
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
import { HostRef, WorkerTarget } from "./Engine.ts";
import type { WorkerServices } from "./Worker.ts";

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
     * whichever worker yields it.
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
       * The implementation layer — cloud- and worker-free. Provide it on
       * the hosting worker's impl (registers the class there) and on
       * callers (resolves the remote stub). A caller supplies the hosting
       * worker with a `.ref` layer:
       * `CounterLive.pipe(Layer.provide(Cloudflare.Worker.ref(Api)))` —
       * omitting it fails to compile via the {@link HostRef} requirement.
       */
      make<Req = never>(
        impl: Effect.Effect<
          Effect.Effect<
            [Shape] extends [never] ? MainRpc<DurableObjectState> : Shape,
            never,
            RuntimeContext | DurableObjectState | Scope
          >,
          never,
          DurableObjectServices | Req
        >,
      ): Layer.Layer<
        Self,
        never,
        HostRef | Exclude<Req, DurableObjectServices>
      >;
    };
  };
}

/**
 * The shape of a resource that can HOST Durable Objects: any native worker
 * resource (Cloudflare / Celld / Rivet) — a `Platform()`-built instance
 * whose runtime context exposes `export` alongside the resource's `bind`.
 * Non-worker hosts (Lambda Functions, ECS tasks) have `bind` but no
 * `export`, which is what routes them to the remote-caller path.
 */
interface WorkerHostLike {
  LogicalId: string;
  bind: (
    template: TemplateStringsArray,
    ...args: any[]
  ) => (data: any) => Effect.Effect<void>;
  export: (name: string, value: any) => Effect.Effect<void>;
}

const isWorkerHost = (value: unknown): value is WorkerHostLike =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  // `in` first: a resource proxy answers property READS for any attribute
  // name with a callable `PropExpr` Output accessor, so `typeof
  // host.export === "function"` alone is true for EVERY resource (a
  // Lambda included). `in` forwards to the proxy target and only reports
  // properties that really exist (`export` is Object.assigned onto worker
  // instances by their runtime context; refs report nothing).
  "bind" in (value as object) &&
  "export" in (value as object) &&
  typeof (value as { bind?: unknown }).bind === "function" &&
  typeof (value as { export?: unknown }).export === "function";

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
    const binding = (host: WorkerHostLike) =>
      Effect.gen(function* () {
        // The target is ambient inside the impl's provide chain (the DO
        // layer sits above it). Its absence here means the deployable
        // module provided no target — surfaced with guidance.
        const target = yield* Effect.serviceOption(WorkerTarget).pipe(
          Effect.map(Option.getOrUndefined),
        );

        const declaration = { name: namespace, className };
        // Binding data is HOST-NATIVE: the target adapter shapes the
        // declaration for its platform's worker binding contract.
        yield* host.bind`${namespace}`(
          target !== undefined
            ? target.durableObjectBinding(declaration)
            : { durableObjects: [declaration] },
        );

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
      host: WorkerHostLike,
      impl: Effect.Effect<
        Effect.Effect<DurableObjectShape>,
        never,
        DurableObjectState
      >,
    ) {
      const self = yield* binding(host);
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
      yield* host.export(namespace, {
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
    const remote = Effect.gen(function* () {
      // The host ref is a real requirement (see Engine.ts): a caller that
      // never pipes `X.Worker.ref(TheWorker)` fails to COMPILE instead of
      // dying in production. It carries the hosting worker's identity,
      // resource handle, engine kind, and connection env keys.
      const hostRef = yield* HostRef;
      const { urlKey, secretKey } = hostRef;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (
          host !== undefined &&
          typeof (host as any).bind === "function" &&
          !isWorkerHost(host)
        ) {
          // The ref's Deployment requirement already ordered the worker
          // node (and its infrastructure) ahead of this host in the
          // stack graph; its resolved handle rides on the ref, and so
          // does the platform's caller binding (absorbed from the deleted
          // engine seam).
          const worker = hostRef.worker as any;
          const data = yield* hostRef.callerBinding({
            worker,
            host,
            urlKey,
            secretKey,
          });
          yield* (host as any)
            .bind`Allow(${host}, Alchemy.Worker.Call(${worker}))`(data);
        }
      }

      const ctx = yield* CurrentRuntimeContext;

      // Read the bound connection once: empty at plan (nothing to call
      // yet), populated inside the deployed host by `callerBinding`.
      const url = ctx ? rawValue(yield* ctx.get(urlKey)) : undefined;
      const secret = ctx ? rawValue(yield* ctx.get(secretKey)) : undefined;
      // The transport rides on the ref (each `.ref` names its cloud
      // statically) — engines are deploy-time layers absent from a
      // deployed caller's bundle, so nothing is looked up at runtime.
      const remoteClient =
        url !== undefined && secret !== undefined
          ? hostRef.remoteDurableObject({ url, secret, namespace })
          : undefined;

      return {
        Type: TypeId,
        LogicalId: namespace,
        name: namespace,
        getByName: (name: string) => {
          if (remoteClient === undefined) {
            throw new Error(
              `DurableObject '${namespace}' is not reachable from this host — ` +
                `it can only be called at runtime, and the worker connection ` +
                `env (${urlKey}) must be bound by the engine's caller binding.`,
            );
          }
          return remoteClient.getByName(name) as DurableObjectStub<any>;
        },
      } satisfies DurableObject<any>;
    });

    /**
     * The layer body: hosting when built inside the worker the ambient
     * {@link HostRef} points at, remote everywhere else. Inside a deploy
     * module (`Cloudflare.Worker(Api, props, ApiLive)`) the wrapper
     * provides a SELF ref, so a DO layer in the hosted impl takes the
     * hosting path; a caller's DO layer pipes a foreign `.ref` and takes
     * the remote path. The host is a property of the LAYER's provide
     * chain — running the class on a different worker is a different ref.
     */
    const dispatch = (
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
        const hostRef = yield* HostRef;
        // Type-agnostic identity match: the host is whatever NATIVE worker
        // resource the deploy wrapper constructed (Cloudflare / Celld /
        // Rivet) — hosting iff its logical id is the ref's worker.
        if (isWorkerHost(host) && host.LogicalId === hostRef.workerId) {
          if (impl === undefined) {
            return yield* Effect.die(
              new Error(
                `DurableObject '${namespace}' is hosted by worker '${host.LogicalId}' but no implementation was provided — provide ${namespace}.make(impl) on the worker impl.`,
              ),
            );
          }
          return yield* makeHost(host, impl);
        }
        return yield* remote;
      });

    if (inlineImpl !== undefined) {
      // Inline form: hosted by whichever worker yields the class; outside
      // a worker it resolves the remote stub through the provided target.
      return class extends effectClass(
        Effect.gen(function* () {
          const host = yield* Binding.Host;
          if (isWorkerHost(host)) {
            return yield* makeHost(host, inlineImpl as any);
          }
          const provided = yield* Effect.serviceOption(tag);
          if (Option.isSome(provided)) {
            return provided.value;
          }
          return yield* Effect.die(
            new Error(
              `DurableObject '${namespace}' was yielded outside a worker ` +
                "without a host reference — pipe the hosting worker's ref " +
                "(e.g. `Layer.provide(Cloudflare.Worker.ref(TheWorker))`).",
            ),
          );
        }),
      ) {};
    }

    return class extends effectClass(tag as Effect.Effect<any, never, any>) {
      static make = <Req = never>(
        impl: Effect.Effect<
          Effect.Effect<DurableObjectShape, never, DurableObjectState | Req>
        >,
      ) => Layer.effect(tag, dispatch(impl as any));
    };
  },
) as any;
