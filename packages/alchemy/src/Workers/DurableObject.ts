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
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ALCHEMY_PHASE } from "../Phase.ts";
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
