/**
 * Shared Durable Object registration and export mechanics: ONE
 * implementation of "register the class on its hosting worker and export
 * it", used by every engine whose workers host Durable Objects (Cloudflare,
 * Celld). Binding registration, runtime-env namespace resolution, the
 * plan-time mock-state evaluation that discovers transitive bindings, and
 * the class export are engine-invariant; the binding data shape and the
 * stub flavor come from the engine.
 *
 * @internal
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Binding from "../Binding.ts";
import { ALCHEMY_PHASE } from "../Phase.ts";
import type { RpcErrorClass } from "../Rpc.ts";
import { effectClass, taggedFunction } from "../Util/effect.ts";
import { WorkerEnvironment } from "./WorkerEnvironment.ts";

/**
 * The lifecycle handlers a Durable Object instance may return. Erased only
 * at the heterogeneous export/dispatch boundary — each engine declares its
 * own precisely typed shape.
 */
export interface DurableObjectShape {
  fetch?: Effect.Effect<any, any, any>;
  alarm?: (...args: any[]) => Effect.Effect<any, any, any>;
  webSocketOpen?: (...args: any[]) => Effect.Effect<any, any, any>;
  webSocketMessage?: (...args: any[]) => Effect.Effect<any, any, any>;
  webSocketClose?: (...args: any[]) => Effect.Effect<any, any, any>;
  webSocketError?: (...args: any[]) => Effect.Effect<any, any, any>;
}

/** The export record a hosting worker publishes per Durable Object class. */
export interface DurableObjectExport<Shape = any> {
  readonly kind: "durableObject";
  /**
   * The class's two-phase constructor: the outer Effect resolves the
   * object's dependencies, the inner one builds each instance.
   */
  readonly constructor: Effect.Effect<Effect.Effect<Shape, never, any>, never, any>;
  /** The infrastructure services the constructor was declared with. */
  readonly services: Context.Context<never>;
}

export const isDurableObjectExport = (value: unknown): value is DurableObjectExport =>
  typeof value === "object" && (value as any)?.kind === "durableObject";

/** The least a native namespace binding found in the runtime environment offers. */
export interface DurableObjectNamespaceLike {
  getByName(name: string, options?: unknown): unknown;
}

/**
 * A resource that can HOST Durable Objects: a worker resource whose
 * runtime context exposes `export` alongside the resource's `bind`.
 */
export interface DurableObjectHostLike {
  readonly bind: (
    template: TemplateStringsArray,
    ...args: any[]
  ) => (data: any) => Effect.Effect<void, never, any>;
  readonly export: (name: string, value: any) => Effect.Effect<void, never, any>;
}

/**
 * Resolve the native namespace binding a class is registered under from
 * the runtime environment; `undefined` at plan time (there is nothing to
 * call yet).
 */
export const resolveDurableObjectNamespace = <Namespace extends DurableObjectNamespaceLike>(
  namespace: string,
): Effect.Effect<Namespace | undefined> =>
  Effect.all([
    Effect.serviceOption(WorkerEnvironment).pipe(Effect.map(Option.getOrUndefined)),
    ALCHEMY_PHASE,
  ]).pipe(
    Effect.flatMap(([env, phase]): Effect.Effect<Namespace | undefined> => {
      if (env === undefined || phase === "plan") {
        return Effect.succeed(undefined);
      }
      const ns: unknown = env[namespace];
      if (!ns) {
        return Effect.die(new Error(`DurableObject '${namespace}' not found`));
      }
      if (
        typeof ns !== "object" ||
        !("getByName" in ns) ||
        typeof (ns as DurableObjectNamespaceLike).getByName !== "function"
      ) {
        return Effect.die(new Error(`DurableObject '${namespace}' is not a DurableObject`));
      }
      return Effect.succeed(ns as Namespace);
    }),
  );

/**
 * Export a class's constructor on its hosting worker. At plan time the
 * constructor's outer Effect runs once against `planContext` (a mock
 * Durable Object state) so the transitive bindings the object depends on
 * are discovered and registered on the worker.
 */
export const exportDurableObjectClass = <Shape>(
  host: DurableObjectHostLike,
  namespace: string,
  constructor: DurableObjectExport<Shape>["constructor"],
  planContext: Context.Context<any>,
) =>
  Effect.gen(function* () {
    const phase = yield* ALCHEMY_PHASE;
    if (phase === "plan") {
      // Provided OVER the ambient context: the constructor still reaches the
      // hosting worker and every other declaration in scope.
      yield* constructor.pipe(Effect.provide(Layer.succeedContext(planContext)), Effect.asVoid);
    }
    yield* host.export(namespace, {
      kind: "durableObject",
      // initialize the object's constructor (apply infra dependencies)
      constructor,
      // grab the object's infra dependencies so we can apply them when
      // calling the instance's methods
      services: yield* Effect.context<never>(),
    } satisfies DurableObjectExport<Shape>);
  });

// ---------------------------------------------------------------------------
// Declarations for engines with local, named namespaces (Celld)
// ---------------------------------------------------------------------------

/** A Durable Object class declaration as registered on its hosting worker. */
export interface DurableObjectBindingDeclaration {
  /** Binding name — the Durable Object's logical id. */
  readonly name: string;
  /** The exported class name backing the binding. */
  readonly className: string;
}

/**
 * The least a native namespace stub offers the engine's stub flavor: an
 * HTTP entry (workerd-style stubs are fetchers).
 */
export interface DurableObjectStubLike {
  readonly fetch?: (
    input: string | URL | globalThis.Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

/** Per-class options a host's stub flavor honors. */
export interface DurableObjectStubOptions {
  /**
   * Tagged-error classes the class's RPC methods can fail with: failures
   * crossing the RPC boundary are reconstructed as real instances (see
   * `RpcErrorClass` in `Rpc.ts`).
   */
  readonly errors?: ReadonlyArray<RpcErrorClass> | undefined;
}

/**
 * A worker resource that hosts Durable Objects through the shared
 * declaration mechanics: `bind`/`export` plus the engine's two variation
 * points, assigned by the engine's runtime context.
 */
export interface DurableObjectEngineHost extends DurableObjectHostLike {
  readonly Type: string;
  /** Host-native binding data for a Durable Object class declaration. */
  readonly durableObjectBinding: (decl: DurableObjectBindingDeclaration) => unknown;
  /** The engine's stub flavor over a native instance stub. */
  readonly durableObjectStub: (
    nativeStub: DurableObjectStubLike,
    namespace: string,
    options: DurableObjectStubOptions,
  ) => unknown;
}

export const isDurableObjectHost = (value: unknown): value is DurableObjectEngineHost =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  // `in` first: a resource proxy answers property READS for any attribute
  // name with a callable Output accessor, so `typeof host.export ===
  // "function"` alone is true for EVERY resource. `in` forwards to the
  // proxy target and only reports properties that really exist.
  "bind" in (value as object) &&
  "export" in (value as object) &&
  "durableObjectBinding" in (value as object) &&
  "durableObjectStub" in (value as object) &&
  typeof (value as { bind?: unknown }).bind === "function" &&
  typeof (value as { export?: unknown }).export === "function";

/** Resolve the ambient hosting worker and reject cross-provider declarations. */
export const requireDurableObjectHost = (namespace: string, provider: string) =>
  Effect.flatMap(Binding.Host, (host) =>
    isDurableObjectHost(host) && host.Type === provider
      ? Effect.succeed(host)
      : Effect.die(
          new Error(
            `DurableObject '${namespace}' requires a ${provider} host; ` +
              `received ${(host as { Type?: string } | undefined)?.Type ?? "no Worker"}.`,
          ),
        ),
  );

/** Planning may compose deferred state Effects, but cannot execute state operations. */
export const durableObjectPlanContext = <I, S>(
  tag: Context.Key<I, S>,
  effectProperties: readonly (keyof S)[] = [],
): Context.Context<I> => {
  const reference = (path: string): unknown =>
    new Proxy(() => {}, {
      get: (_target, key) =>
        path === tag.key && effectProperties.includes(key as keyof S)
          ? Effect.die(new Error(`${path}.${String(key)} can only be called at runtime`))
          : reference(`${path}.${String(key)}`),
      apply: () => {
        const error = new Error(`${path} can only be called at runtime`);
        if (path.split(".").some((key) => ["raw", "kv", "id", "container"].includes(key))) {
          throw error;
        }
        return Effect.die(error);
      },
    });
  return Context.make(tag, reference(tag.key) as S);
};

/**
 * The class/layer mechanics of a Durable Object declaration for engines
 * whose namespaces are local to the hosting worker: the inline form
 * (`(name, impl)`), the class form with an inline impl
 * (`<Self>()(name, impl)`), and the modular class form
 * (`<Self, Shape>()(name, props?)` + `static make(impl)`).
 */
export const makeDurableObjectDeclaration = (
  scope: Context.Key<any, any>,
  options: {
    readonly kind: string;
    readonly provider: string;
    readonly planContext: Context.Context<any>;
  },
) => {
  const declaration = taggedFunction(
    scope as any,
    function (
      name?: string,
      propsOrImpl?: DurableObjectStubOptions | Effect.Effect<any, never, any>,
      classForm = false,
    ): any {
      if (name === undefined) {
        return (
          name: string,
          propsOrImpl?: DurableObjectStubOptions | Effect.Effect<any, never, any>,
        ) => declaration(name, propsOrImpl, true);
      }
      const tag = Context.Service(`${options.kind}.${name}`);
      const props = Effect.isEffect(propsOrImpl) ? undefined : propsOrImpl;
      const make = (constructor: DurableObjectExport["constructor"]) =>
        Effect.gen(function* () {
          const host = yield* requireDurableObjectHost(name, options.provider);
          // Binding data is HOST-NATIVE: the host's runtime context shapes
          // the declaration for its platform's worker binding contract.
          yield* host.bind`${name}`(host.durableObjectBinding({ name, className: name }));
          const native = yield* resolveDurableObjectNamespace<
            DurableObjectNamespaceLike & {
              getByName(name: string): DurableObjectStubLike;
            }
          >(name);
          const self = {
            kind: options.kind,
            Type: options.kind,
            name,
            getByName: (key: string) => {
              if (native === undefined) {
                throw new Error(`DurableObject '${name}' can only be called at runtime`);
              }
              return host.durableObjectStub(
                native.getByName(key) as DurableObjectStubLike,
                name,
                props ?? {},
              );
            },
          };
          yield* exportDurableObjectClass(
            host,
            name,
            constructor.pipe(Effect.provideService(scope, self)),
            options.planContext,
          );
          return self;
        });

      if (Effect.isEffect(propsOrImpl)) {
        return effectClass(
          make(
            classForm
              ? (propsOrImpl as DurableObjectExport["constructor"])
              : propsOrImpl.pipe(Effect.map(Effect.succeed)),
          ),
        );
      }
      return class extends effectClass(tag as Effect.Effect<any, never, any>) {
        static make = (constructor: DurableObjectExport["constructor"]) =>
          Layer.effect(tag, make(constructor));
      };
    },
  );
  return declaration;
};
