import type { HttpEffect } from "alchemy/Http";
import type { InputProps } from "alchemy/Input";
import type { Named } from "alchemy/Named";
import {
  Platform,
  type PlatformIdentity,
  type PlatformProps,
  type PlatformServices,
} from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import { createHostRuntimeContext, type HostRuntimeContext } from "alchemy/Runtime/Process";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type { Self } from "alchemy/Self";
import type * as ConfigError from "effect/Config";
import type * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { Scope } from "effect/Scope";
import type { DurableObjectState } from "./DurableObjectState.ts";
import type { Providers } from "./Providers.ts";

export const DurableObjectTypeId = "Rivet.DurableObject";
export type DurableObjectTypeId = typeof DurableObjectTypeId;

export interface DurableObjectProps extends PlatformProps {
  /** The module that exports this Durable Object, usually `import.meta.url`. */
  main: string;
  /**
   * The export of {@link main} that holds this Durable Object: the class,
   * or the Layer its `.make(...)` returned.
   * @default "default"
   */
  handler?: string;
}

export interface DurableObjectAttributes {
  /** The actor name the control plane knows this class by. */
  name: string;
  /** The pool whose nodes host it. */
  pool: string | undefined;
}

/** Data a pool binds onto the Durable Objects it hosts. */
export interface DurableObjectBindingContract {
  /** The pool whose nodes host the Durable Object. */
  pool?: string;
}

export interface DurableObject extends Resource<
  DurableObjectTypeId,
  DurableObjectProps,
  DurableObjectAttributes,
  DurableObjectBindingContract,
  Providers
> {}

/** The lifecycle handlers a Rivet Durable Object instance may implement. */
export interface DurableObjectShape {
  fetch?: HttpEffect<DurableObjectState | RuntimeContext>;
  alarm?: () => Effect.Effect<void, never, RuntimeContext | DurableObjectState | Scope>;
}

/** What an instance's constructor runs with: once per actor. */
export type InstanceServices = RuntimeContext | DurableObjectState | Scope;

/** Services the class phase may use without the caller providing them. */
export type DurableObjectServices =
  | DurableObject
  | Providers
  | RuntimeContext
  | Self
  | Self<DurableObject>;

type ClassProps<PropsReq> =
  | InputProps<DurableObjectProps>
  | Effect.Effect<InputProps<DurableObjectProps>, ConfigError.ConfigError, PropsReq>;

type ClassRequirements<Req> = Providers | Exclude<Req, DurableObjectServices | PlatformServices>;

/** The class surface of {@link DurableObject}. */
export interface DurableObjectClass {
  <Self, Shape = {}>(): {
    /** The class form with an inline implementation. */
    <
      const Id extends string,
      // The index signature keeps the all-optional lifecycle shape from
      // being a weak type that rejects every inferred RPC shape.
      S extends Shape & DurableObjectShape & Record<string, unknown>,
      PropsReq = never,
      InitReq = never,
    >(
      id: Id,
      props: ClassProps<PropsReq>,
      impl: Effect.Effect<
        Effect.Effect<S, never, InstanceServices>,
        ConfigError.ConfigError,
        InitReq
      >,
    ): Effect.Effect<DurableObject, never, ClassRequirements<PropsReq | InitReq>> &
      Named<Id> &
      PlatformIdentity<Id> & {
        new (_: never): S;
      };
    /** A bare declaration, implemented by `.make(props, impl)`. */
    <const Id extends string>(
      id: Id,
    ): Effect.Effect<DurableObject, never, Providers> &
      Named<Id> &
      PlatformIdentity<Id> & {
        new (_: never): Shape;
        make<PropsReq = never, InitReq = never>(
          props: ClassProps<PropsReq>,
          impl: Effect.Effect<
            Effect.Effect<Shape & DurableObjectShape, never, InstanceServices>,
            ConfigError.ConfigError,
            InitReq
          >,
        ): Layer.Layer<Self, never, ClassRequirements<PropsReq | InitReq>>;
      };
  };
}

/** The Durable Object was deployed without a pool Layer, so nothing would host it. */
export class DurableObjectHasNoPool extends Data.TaggedError("Rivet.DurableObjectHasNoPool")<{
  readonly message: string;
}> {}

/**
 * A Durable Object class as a node runs it: the instance constructor its
 * class phase returned, and the services that phase ran with.
 * @internal
 */
export interface HostedDurableObject {
  readonly name: string;
  readonly instance: Effect.Effect<DurableObjectShape & Record<string, unknown>, never, any>;
  readonly context: Context.Context<never>;
  readonly runtime: DurableObjectRuntimeContext;
}

/** Declares the pool resources for one Durable Object, given its collected env. @internal */
export type DeployToPool = (env: Record<string, unknown>) => Effect.Effect<void, never, any>;

export interface DurableObjectRuntimeContext extends HostRuntimeContext {
  readonly Type: DurableObjectTypeId;
  readonly alwaysServe: true;
  /**
   * Called by a pool Layer while the class phase runs: `deploy` declares the
   * pool that hosts this class, once its env is collected.
   * @internal
   */
  readonly registerPool: (deploy: DeployToPool) => Effect.Effect<void>;
  /** At runtime, the built class, once its class phase has run. @internal */
  readonly hosted: () => HostedDurableObject | undefined;
}

const createRuntimeContext = (id: string): DurableObjectRuntimeContext => {
  const base = createHostRuntimeContext(DurableObjectTypeId)(id);
  let deploy: DeployToPool | undefined;
  let hosted: HostedDurableObject | undefined;

  const ctx: DurableObjectRuntimeContext = {
    ...base,
    Type: DurableObjectTypeId,
    // The class phase returns the instance constructor rather than a
    // handler shape: always hand it to `serve`.
    alwaysServe: true,
    registerPool: (next) =>
      Effect.sync(() => {
        deploy = next;
      }),
    hosted: () => hosted,
    serve: (_handler, options) =>
      Effect.gen(function* () {
        // `shape` is what the class phase returned: the instance constructor.
        const instance = options?.shape as unknown as HostedDurableObject["instance"];
        if (globalThis.__ALCHEMY_RUNTIME__) {
          hosted = { name: id, instance, context: yield* Effect.context<never>(), runtime: ctx };
          return;
        }
        // The class phase has run, so every Config value it read is in `env`.
        if (deploy === undefined) {
          return yield* Effect.die(
            new DurableObjectHasNoPool({
              message:
                `Rivet.DurableObject '${id}' has no pool. Provide a pool Layer to its Effect, ` +
                `for example RivetDocker.Pool("Default") or RivetAWS.EcsPool("Default").`,
            }),
          );
        }
        yield* deploy(base.env);
      }),
  };
  return ctx;
};

/**
 * A **Durable Object** on Rivet: a single-threaded, stateful instance per
 * name, with its own SQLite database, key-value storage and alarm on the
 * Rivet control plane. Each instance runs as a Rivet actor.
 *
 * The implementation has the same two phases as `Cloudflare.DurableObject`:
 * the outer Effect runs once per node and resolves bindings, and the inner
 * Effect runs once per instance and returns its RPC methods, `fetch` and
 * `alarm`.
 *
 * Where it runs is a pool Layer provided to the outer Effect —
 * `RivetDocker.Pool("Default")`, `RivetAWS.EcsPool("Default")` — and the
 * pool is given the control plane. Every Durable Object given the same pool
 * runs on the same nodes. Call it from any runtime with `Rivet.Client`.
 *
 * ### Declaring a Durable Object
 * **Example:** A counter on a local pool
 * ```typescript
 * export const Cluster = RivetDocker.ControlPlane("Rivet");
 * export const Default = RivetDocker.Pool("Default").pipe(Layer.provide(Cluster));
 *
 * export default class Counter extends Rivet.DurableObject<Counter>()(
 *   "Counter",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     return Effect.gen(function* () {
 *       const state = yield* Rivet.DurableObjectState;
 *       return {
 *         increment: () =>
 *           Effect.gen(function* () {
 *             const count = ((yield* state.storage.get<number>("count")) ?? 0) + 1;
 *             yield* state.storage.put("count", count);
 *             return count;
 *           }),
 *       };
 *     });
 *   }).pipe(Effect.provide(Default)),
 * ) {}
 * ```
 *
 * ### Declaring and implementing separately
 * **Example:** A declaration callers import, and its implementation
 * ```typescript
 * export class Counter extends Rivet.DurableObject<Counter, CounterShape>()("Counter") {}
 *
 * export const CounterLive = Counter.make(
 *   { main: import.meta.url, handler: "CounterLive" },
 *   Effect.gen(function* () {
 *     return Effect.gen(function* () {
 *       const state = yield* Rivet.DurableObjectState;
 *       return {
 *         get: () => state.storage.get<number>("count").pipe(Effect.map((n) => n ?? 0)),
 *       };
 *     });
 *   }).pipe(Effect.provide(Default)),
 * );
 * ```
 *
 * @resource
 * @product Rivet
 */
export const DurableObject: DurableObjectClass & DurableObjectPlatform = Platform(
  DurableObjectTypeId,
  { createRuntimeContext },
) as DurableObjectPlatform as DurableObjectClass & DurableObjectPlatform;

/** The engine-facing Platform behind {@link DurableObject}. */
type DurableObjectPlatform = Platform<
  DurableObject,
  DurableObjectServices,
  unknown,
  DurableObjectRuntimeContext
>;

export const DurableObjectProvider = () =>
  Provider.succeed(DurableObject, {
    stables: ["name"],
    reconcile: ({ id, bindings }) =>
      Effect.sync(() => {
        let pool: string | undefined;
        for (const binding of bindings) {
          if (binding.data.pool !== undefined) pool = binding.data.pool;
        }
        return { name: id, pool };
      }),
    delete: () => Effect.void,
  });
