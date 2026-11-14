import * as nodePath from "node:path";
import type { HttpEffect } from "alchemy/Http";
import type { InputProps } from "alchemy/Input";
import type { Named } from "alchemy/Named";
import * as Output from "alchemy/Output";
import {
  Platform,
  type PlatformIdentity,
  type PlatformProps,
  type PlatformServices,
} from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import { makeFetchRpcStub, type RpcCallError } from "alchemy/Rpc";
import { createHostRuntimeContext, type HostRuntimeContext } from "alchemy/Runtime/Process";
import { RuntimeContext, sanitizeKey } from "alchemy/RuntimeContext";
import type { Self } from "alchemy/Self";
import type * as ConfigError from "effect/Config";
import * as Config from "effect/Config";
import type * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { HttpServerError } from "effect/http/HttpServerError";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { Scope } from "effect/Scope";
import type { DurableObjectState } from "./DurableObjectState.ts";
import { PoolHost } from "./Host.ts";
import { fromNativeFetcher } from "./internal/Fetcher.ts";
import { gatewayFetcher, type GatewayTarget } from "./internal/Gateway.ts";
import type { CargoBuild } from "./internal/RustProgram.ts";
import type { Providers } from "./Providers.ts";
import type { WebSocket } from "./WebSocket.ts";

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
  /** The control plane URL callers send requests to. */
  endpoint: string | undefined;
  /** The namespace its actors live in. */
  namespace: string | undefined;
  /** The token callers present to the gateway. */
  token: Redacted.Redacted<string> | undefined;
}

/** Data a pool binds onto the Durable Objects it hosts. */
export interface DurableObjectBindingContract {
  /** The pool whose nodes host the Durable Object. */
  pool?: string;
  /** The control plane URL callers send requests to. */
  endpoint?: string;
  /** The namespace its actors live in. */
  namespace?: string;
  /** The token callers present to the gateway. */
  token?: Redacted.Redacted<string>;
}

/** One instance of a Durable Object: its RPC methods and its `fetch`. */
export type DurableObjectStub<Shape> = Shape & {
  fetch(
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpServerError | RpcCallError,
    RuntimeContext
  >;
};

/** Every instance of one Durable Object class, addressed by name. */
export interface DurableObjectNamespace<Shape> {
  /** The actor name: the class's logical id. */
  readonly name: string;
  /** The instance called `name`, created on first use. */
  getByName(name: string): DurableObjectStub<Shape>;
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
  /** A message on a WebSocket this instance accepted with `Rivet.upgrade()`. */
  webSocketMessage?: (
    socket: WebSocket,
    message: string | Uint8Array,
  ) => Effect.Effect<void, never, RuntimeContext | DurableObjectState | Scope>;
  /** A WebSocket this instance accepted closed. */
  webSocketClose?: (
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ) => Effect.Effect<void, never, RuntimeContext | DurableObjectState | Scope>;
  /** A WebSocket this instance accepted failed. */
  webSocketError?: (
    socket: WebSocket,
    error: unknown,
  ) => Effect.Effect<void, never, RuntimeContext | DurableObjectState | Scope>;
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

export type { CargoBuild } from "./internal/RustProgram.ts";

/** Props of an external Durable Object: a RivetKit program, run as it is. */
export interface ExternalDurableObjectProps {
  /**
   * The program's entry file, relative to where the deploy runs: a RivetKit
   * registry that calls `registry.start()`, or a `@rivetkit/effect` program
   * that launches `Registry.serve`. It is bundled and run on the pool's
   * nodes unchanged, with `RIVET_ENDPOINT`, `RIVET_TOKEN`,
   * `RIVET_NAMESPACE` and `RIVET_POOL` set.
   */
  main: string;
  crate?: never;
}

/** Props of a Rust Durable Object: Actors written with RivetKit's Rust crate, run as they are. */
export interface RustDurableObjectProps {
  /**
   * The crate, relative to where the deploy runs: its directory or its
   * `Cargo.toml`. Its binary calls `registry().start()`, and is compiled
   * into the pool's node image and run unchanged, with `RIVET_ENDPOINT`,
   * `RIVET_TOKEN`, `RIVET_NAMESPACE` and `RIVET_POOL` set. A crate in a
   * Cargo workspace is built from the workspace, as Cargo builds it.
   */
  crate: string;
  /** How the crate is compiled. */
  build?: CargoBuild;
  main?: never;
}

/** The class surface of {@link DurableObject}. */
export interface DurableObjectClass {
  /**
   * An external Durable Object: Actors written with RivetKit, in its async
   * or Effect form, deployed as they are. Provide a pool Layer to it.
   */
  <const Id extends string>(
    id: Id,
    props: ExternalDurableObjectProps,
  ): Effect.Effect<DurableObject, never, PoolHost | Providers>;
  /**
   * A Rust Durable Object: Actors written with RivetKit's Rust crate,
   * compiled into the node image. Provide a pool Layer to it.
   */
  <const Id extends string>(
    id: Id,
    props: RustDurableObjectProps,
  ): Effect.Effect<DurableObject, never, PoolHost | Providers>;
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
    ): Effect.Effect<DurableObjectNamespace<S>, never, ClassRequirements<PropsReq | InitReq>> &
      Named<Id> &
      PlatformIdentity<Id> & {
        new (_: never): S;
      };
    /** A bare declaration, implemented by `.make(props, impl)`. */
    <const Id extends string>(
      id: Id,
    ): Effect.Effect<DurableObjectNamespace<Shape>, never, Providers> &
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
          hosted = {
            name: id,
            instance,
            context: yield* Effect.context<never>(),
            runtime: ctx,
          };
          return;
        }
        // The class phase has run, so every Config value it read is in `env`.
        if (deploy === undefined) {
          return yield* Effect.die(
            new DurableObjectHasNoPool({
              message:
                `Rivet.DurableObject '${id}' has no pool. Provide a pool Layer to its Effect, ` +
                `for example RivetDocker.SwarmPool("Default") or RivetAWS.EcsPool("Default").`,
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
 * `RivetDocker.SwarmPool("Default")`, `RivetAWS.EcsPool("Default")` — and the
 * pool is given the control plane. Every Durable Object given the same pool
 * runs on the same nodes.
 *
 * `yield* Counter` from any runtime — a Cloudflare Worker, a Lambda, a
 * container, another Durable Object — returns its namespace. Calls go
 * through the control plane's gateway over plain `fetch`, which creates the
 * instance in its pool on first use, so callers need no RivetKit and no
 * route to the nodes.
 *
 * Given only `main`, it is external: a RivetKit program, async or
 * `@rivetkit/effect`, that its pool bundles and runs as it is. Given a
 * `crate`, it is a Rust program that its pool compiles into the node image.
 * Either needs a pool of its own, and has no bindings or `yield*` calls.
 *
 * An instance's calls run in parallel, storage included: unlike Cloudflare,
 * there is no input gate. Make a read-then-write atomic with
 * `state.storage.transaction(...)`, or provide `Workers.InputGate` (from
 * `alchemy/Workers`) to run code written for Cloudflare's gate unchanged.
 *
 * ### Declaring a Durable Object
 * **Example:** A counter on a local pool
 * ```typescript
 * export const Cluster = RivetDocker.SwarmControlPlane("Rivet");
 * export const Default = RivetDocker.SwarmPool("Default").pipe(Layer.provide(Cluster));
 *
 * export default class Counter extends Rivet.DurableObject<Counter>()(
 *   "Counter",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     return Effect.gen(function* () {
 *       const state = yield* Rivet.DurableObjectState;
 *       return {
 *         // Calls run in parallel: the transaction keeps the read and
 *         // the write together.
 *         increment: () =>
 *           state.storage.transaction(
 *             Effect.gen(function* () {
 *               const count = ((yield* state.storage.get<number>("count")) ?? 0) + 1;
 *               yield* state.storage.put("count", count);
 *               return count;
 *             }),
 *           ),
 *       };
 *     });
 *   }).pipe(Effect.provide(Default)),
 * ) {}
 * ```
 *
 * ### Calling a Durable Object
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const counters = yield* Counter;
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const count = yield* counters.getByName("visits").increment();
 *         return HttpServerResponse.text(String(count));
 *       }),
 *     };
 *   }),
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
 * ### Deploying RivetKit Actors
 * **Example:** Actors written with RivetKit, or `@rivetkit/effect`, run unchanged
 * ```typescript
 * export const Counters = RivetDocker.SwarmPool("Counters").pipe(Layer.provide(Cluster));
 *
 * export const Counter = Rivet.DurableObject("Counter", { main: "./src/actors.ts" }).pipe(
 *   Effect.provide(Counters),
 * );
 * ```
 *
 * ### Deploying Rust Actors
 * **Example:** A crate compiled into the pool's node image
 * ```typescript
 * export const Counters = RivetDocker.SwarmPool("Counters").pipe(Layer.provide(Cluster));
 *
 * export const Counter = Rivet.DurableObject("Counter", { crate: "./counter" }).pipe(
 *   Effect.provide(Counters),
 * );
 * ```
 *
 * **Example:** Features, a pinned toolchain and system packages
 * ```typescript
 * export const Counter = Rivet.DurableObject("Counter", {
 *   crate: "./crates/counter",
 *   build: {
 *     toolchain: "1.85",
 *     features: ["metrics"],
 *     packages: ["protobuf-compiler"],
 *   },
 * }).pipe(Effect.provide(Counters));
 * ```
 *
 * @resource
 */
export const DurableObject: DurableObjectClass = ((
  ...args: [string, ExternalDurableObjectProps | RustDurableObjectProps] | []
) =>
  args.length === 0
    ? (id: string, props?: unknown, impl?: unknown) =>
        declare(id, (platform as any)()(id, props, impl))
    : args[1].crate !== undefined
      ? rust(args[0], args[1] as RustDurableObjectProps)
      : external(args[0], args[1] as ExternalDurableObjectProps)) as unknown as DurableObjectClass;

/**
 * An external Durable Object: declare its resource, then have the pool it
 * was given run its program. The pool Layer is what provides `PoolHost`.
 */
const external = (id: string, props: ExternalDurableObjectProps) =>
  Effect.gen(function* () {
    const resource: DurableObject = yield* (platform as any)(id, { main: props.main });
    if (globalThis.__ALCHEMY_RUNTIME__) return resource;
    const host = yield* PoolHost;
    const main = yield* Effect.sync(() => nodePath.resolve(props.main));
    yield* host.deployExternal({ id, main, resource });
    return resource;
  });

/**
 * A Rust Durable Object: declare its resource, then have the pool it was
 * given compile its crate into the node image. The pool Layer is what
 * provides `PoolHost`.
 */
const rust = (id: string, props: RustDurableObjectProps) =>
  Effect.gen(function* () {
    const crate = yield* Effect.sync(() => nodePath.resolve(props.crate));
    const resource: DurableObject = yield* (platform as any)(id, { main: crate });
    if (globalThis.__ALCHEMY_RUNTIME__) return resource;
    const host = yield* PoolHost;
    yield* host.deployCrate({ id, crate, build: props.build, resource });
    return resource;
  });

/** The engine-facing Platform behind {@link DurableObject}. */
type DurableObjectPlatform = Platform<
  DurableObject,
  DurableObjectServices,
  unknown,
  DurableObjectRuntimeContext
>;

const platform = Platform(DurableObjectTypeId, { createRuntimeContext }) as DurableObjectPlatform;

/** The resource type behind every class, which the providers register. @internal */
export const DurableObjectResource = platform;

/** The Platform declaration behind a class, which a node builds. @internal */
export const PlatformDeclaration = Symbol.for("alchemy/Rivet/DurableObject/Platform");

/**
 * A class whose `yield*` is its namespace. While deploying it registers the
 * class (through its Platform declaration) and binds what a caller needs into
 * the caller's environment; at runtime it only reads them back, so the class
 * phase never runs in a caller.
 */
const declare = (id: string, declaration: any) =>
  Object.assign(
    class {},
    declaration.make === undefined ? {} : { make: declaration.make },
    { LogicalId: id, [PlatformDeclaration]: declaration },
    Effectable.Prototype({
      label: `${DurableObjectTypeId}<${id}>`,
      evaluate: () => namespaceOf(id, declaration),
    }),
  );

const namespaceOf = (name: string, declaration: Effect.Effect<DurableObject, never, any>) =>
  Effect.gen(function* () {
    const ctx = Option.getOrUndefined(yield* Effect.serviceOption(RuntimeContext));
    // Its own namespace, yielded from its own phase: it's already being
    // built. It runs on its pool's nodes, which have the control plane in
    // their environment; binding its own outputs into its environment would
    // make it depend on itself.
    if (ctx?.Type === DurableObjectTypeId && ctx.id === name) {
      return makeNamespace(
        name,
        yield* Config.all({
          endpoint: Config.String("RIVET_ENDPOINT").pipe(Config.withDefault("")),
          token: Config.String("RIVET_TOKEN").pipe(Config.withDefault("")),
          namespace: Config.String("RIVET_NAMESPACE").pipe(Config.withDefault("")),
          pool: Config.String("RIVET_POOL").pipe(Config.withDefault("")),
        }).pipe(Effect.orDie),
      );
    }
    // Built on a memo map of its own: a class built inside another's phase
    // would otherwise reuse the caller's already-built pool Layer, which
    // then never registers the class.
    const object = globalThis.__ALCHEMY_RUNTIME__
      ? undefined
      : yield* declaration.pipe(
          Effect.provideServiceEffect(Layer.CurrentMemoMap, Layer.makeMemoMap),
        );
    // Outside a runtime (the stack itself) there is nothing to call from.
    if (ctx === undefined) return makeNamespace(name, undefined);
    // Bound as environment values while deploying; read back at runtime.
    const bind = <T>(key: string, value: unknown) =>
      ctx
        .set(
          sanitizeKey(`RIVET_${name}_${key}`),
          Output.isOutput(value) ? value : Output.literal(value),
        )
        .pipe(Effect.flatMap((bound) => ctx.get<T>(bound)));
    const token = yield* bind<Redacted.Redacted<string> | string>("TOKEN", object?.token);
    return makeNamespace(name, {
      endpoint: (yield* bind<string>("ENDPOINT", object?.endpoint)) ?? "",
      namespace: (yield* bind<string>("NAMESPACE", object?.namespace)) ?? "",
      pool: (yield* bind<string>("POOL", object?.pool)) ?? "",
      token: token === undefined ? "" : Redacted.isRedacted(token) ? Redacted.value(token) : token,
    });
  });

/** Stubs over the gateway; RPC crosses it as fetch-RPC over the actor's `fetch`. @internal */
export const makeNamespace = (
  name: string,
  target: Omit<GatewayTarget, "name" | "key"> | undefined,
): DurableObjectNamespace<any> => ({
  name,
  getByName: (key: string) => {
    if (target === undefined) {
      const outside = Effect.die(
        new DurableObjectCalledOutsideRuntime({
          message: `Rivet.DurableObject '${name}' can only be called inside a runtime.`,
        }),
      );
      return makeFetchRpcStub<Record<string, unknown>>({
        fetch: () => outside,
        base: { fetch: () => outside },
      }) as DurableObjectStub<any>;
    }
    const fetcher = fromNativeFetcher(gatewayFetcher({ ...target, name, key }));
    return makeFetchRpcStub<Record<string, unknown>>({
      fetch: (request: HttpClientRequest.HttpClientRequest) =>
        // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- erases RuntimeContext, which the caller's runtime provides at call time
        fetcher.fetch(request) as Effect.Effect<HttpClientResponse.HttpClientResponse, unknown>,
      base: {
        fetch: (request: HttpServerRequest.HttpServerRequest) => fetcher.fetch(request),
      },
    }) as DurableObjectStub<any>;
  },
});

/** A namespace yielded outside any runtime was called. */
export class DurableObjectCalledOutsideRuntime extends Data.TaggedError(
  "Rivet.DurableObjectCalledOutsideRuntime",
)<{
  readonly message: string;
}> {}

export const DurableObjectProvider = () =>
  Provider.succeed(platform, {
    stables: ["name"],
    reconcile: ({ id, bindings }) =>
      Effect.sync(() => {
        const attrs: DurableObjectAttributes = {
          name: id,
          pool: undefined,
          endpoint: undefined,
          namespace: undefined,
          token: undefined,
        };
        for (const { data } of bindings) {
          attrs.pool = data.pool ?? attrs.pool;
          attrs.endpoint = data.endpoint ?? attrs.endpoint;
          attrs.namespace = data.namespace ?? attrs.namespace;
          attrs.token = data.token ?? attrs.token;
        }
        return attrs;
      }),
    delete: () => Effect.void,
  });
