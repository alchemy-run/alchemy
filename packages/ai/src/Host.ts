/**
 * Hosting a process: each of its sessions in an instance of its own.
 *
 * A process's Layer runs every session where it is built. A host takes that
 * Layer and gives back the same process, as a client: `get(key)` is a handle
 * on the instance of that session, which builds the Layer for itself. Where
 * the instances live is the host's: this process's memory
 * ({@link layerInMemory}), or an object each on whatever provides an
 * `ObjectHost` ({@link layerObjects}): a Cloudflare Durable Object, a Rivet
 * actor, an Effect Cluster entity, or a platform of your own.
 *
 * @module
 */
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { InstanceSetup } from "alchemy/Workers/InstanceSetup";
import { ObjectHost, unwrapDefects } from "alchemy/Workers/ObjectHost";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { declared, HostedTypeId, type DeclaredProcess, type Hosted } from "./Process.ts";

/** A value that crosses from a session's instance to its callers. */
type Wire = unknown;

/** One instance: it answers the calls made to the sessions it holds. */
export interface Instance {
  readonly call: (
    key: string,
    method: string,
    args: ReadonlyArray<Wire>,
  ) => Effect.Effect<Wire, never, RuntimeContext>;
}

/** How to build one instance of a process, handed to whatever keeps the instances. */
export type MakeInstance = (host: {
  /**
   * Whether the instance runs apart from the code that hosts it (a Durable
   * Object), and so builds the Layer for itself. Otherwise it is the Layer
   * as the host built it.
   */
  readonly apart: boolean;
}) => Effect.Effect<Instance, never, RuntimeContext | Scope.Scope>;

/** A call to the instance that holds the session `key`, one instance per key. */
export interface Instances {
  readonly call: (
    key: string,
    method: string,
    args: ReadonlyArray<Wire>,
  ) => Effect.Effect<Wire, never, RuntimeContext>;
}

/**
 * One instance of `process`: the sessions it serves. Apart from its host,
 * it builds the Layer for itself.
 */
const instanceOf =
  <A, E, R>(
    process: DeclaredProcess,
    layer: Layer.Layer<A, E, R>,
    /** What the Layer is built with: what the host was given, and each hosted process's client. */
    services: Context.Context<never>,
    /** The Layer as the host built it. */
    local: () => Context.Context<unknown>,
  ): MakeInstance =>
  ({ apart }) =>
    Effect.gen(function* () {
      const hosted = process[HostedTypeId];
      const own = Effect.gen(function* () {
        const scope = yield* Effect.scope;
        // What the instance itself runs with wins over what the host was given.
        const ambient = yield* Effect.context<never>();
        const setup: Array<Effect.Effect<void, never, RuntimeContext>> = [];
        // A harness is one per instance, so the Layer is built here, apart from every other build.
        // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- `services` holds what the Layer requires
        const context = yield* Layer.buildWithMemoMap(layer, Layer.makeMemoMapUnsafe(), scope).pipe(
          Effect.provideContext(
            Context.merge(
              Context.add(services, InstanceSetup, { add: (effect) => void setup.push(effect) }),
              Context.omit(InstanceSetup)(ambient),
            ),
          ),
          Effect.orDie,
        ) as Effect.Effect<Context.Context<unknown>>;
        // What a library asked to run once the instance exists: a harness opens here.
        // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- an instance is built inside its runtime
        for (const effect of setup) yield* effect as Effect.Effect<void>;
        return context;
      });
      const built = apart ? yield* own : local();
      const service = Context.getUnsafe(built, process as Context.Key<unknown, unknown>);

      const methods = new Map<string, ReturnType<Hosted["serve"]>>();
      return {
        call: (key, method, args) =>
          Effect.suspend(() => {
            let served = methods.get(key);
            if (served === undefined) methods.set(key, (served = hosted.serve(service, key)));
            const run = served[method];
            return run === undefined
              ? Effect.die(new Error(`${process.processName} has no method ${method}`))
              : run(...args);
          }),
      };
    });

/**
 * Host every process `layer` provides, each session in an instance that
 * `declare` keeps. The Layer may require the processes it provides: a model
 * it is given whose policy holds one. Inside an instance and out, they are
 * the clients this returns.
 *
 * {@link layerInMemory} and {@link layerObjects} are built on it. Use it to
 * keep the instances somewhere neither covers.
 */
export const make = <A, E, R, R2>(
  layer: Layer.Layer<A, E, R>,
  /** Keep the instances of the process named `name`, each built by `instance`. */
  declare: (name: string, instance: MakeInstance) => Effect.Effect<Instances, never, R2>,
): Layer.Layer<A, E, Exclude<R, A> | R2> =>
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the build is given what `R` names, but for the processes this provides
  Layer.effectContext(
    Effect.gen(function* () {
      const given = Context.omit(Scope.Scope)(yield* Effect.context<never>());
      const scope = yield* Effect.scope;
      const memoMap = yield* Layer.CurrentMemoMap;
      const instances = new Map<string, Instances>();
      // The Layer as this code built it: set once it is.
      let local: Context.Context<unknown> | undefined;
      // The Layer does not say which processes it provides, so every declared
      // one that nothing else provides gets a client. Those it turns out to
      // provide are hosted; a call to another one finds no instances.
      let clients = Context.empty() as Context.Context<never>;
      for (const process of declared.values()) {
        if (Option.isSome(Context.getOption(given, process))) continue;
        clients = Context.add(
          clients,
          process,
          process[HostedTypeId].client(
            {
              call: (key, method, ...args) => {
                const hosted = instances.get(process.processName);
                return hosted === undefined
                  ? Effect.die(new Error(`${process.processName} is not hosted here.`))
                  : hosted.call(key, method, args);
              },
            },
            () => Context.getUnsafe(local!, process as Context.Key<unknown, unknown>),
          ) as never,
        );
      }
      const services = Context.merge(given, clients);
      // Built once here too, with the Layers around it: what it binds at
      // deploy is bound, and a model it is given is the one everything else
      // is given.
      const built = (yield* Layer.buildWithMemoMap(layer, memoMap, scope).pipe(
        Effect.provideContext(services),
      )) as Context.Context<unknown>;
      local = built;
      let provided = Context.empty() as Context.Context<never>;
      for (const process of declared.values()) {
        if (Option.isNone(Context.getOption(built, process))) continue;
        instances.set(
          process.processName,
          yield* declare(
            process.processName,
            instanceOf(process, layer, services, () => local!),
          ),
        );
        provided = Context.add(provided, process, Context.getUnsafe(clients, process) as never);
      }
      return provided as unknown as Context.Context<A>;
    }),
  ) as Layer.Layer<A, E, Exclude<R, A> | R2>;

/**
 * Host a process in this program's memory. Give it the process's Layer
 * with everything it needs. It gives back the same process, with its
 * sessions running here.
 *
 * The Layer may need the process it provides, as a Domain model whose
 * policy holds it does: the host provides it. Use it in tests and
 * single-process apps; `AICloudflare.layerDurableObjects` takes the same
 * Layer.
 *
 * **Example:** A board and the process it hands issues to, in memory
 * ```typescript
 * const BoardInMemory = Board.layer(IssueWorkLive).pipe(Layer.provide(Domain.InMemory));
 *
 * const TriageInMemory = AI.layerInMemory(
 *   TriagePlayed.pipe(Layer.provide(BoardInMemory)),
 * );
 *
 * const Live = BoardInMemory.pipe(Layer.provideMerge(TriageInMemory));
 * ```
 */
export const layerInMemory = <A, E, R>(
  layer: Layer.Layer<A, E, R>,
): Layer.Layer<A, E, Exclude<R, A>> =>
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the Layer's own Scope holds the instance
  make(layer, (_name, instance) =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      // Every session shares the Layer as it was built here, so one instance holds them all.
      let made: Instance | undefined;
      const lock = yield* Semaphore.make(1);
      const held = lock.withPermits(1)(
        Effect.suspend(() =>
          made !== undefined
            ? Effect.succeed(made)
            : instance({ apart: false }).pipe(
                Effect.provideService(Scope.Scope, scope),
                Effect.tap((instance) => Effect.sync(() => void (made = instance))),
              ),
        ),
      );
      return {
        call: (key, method, args) =>
          Effect.flatMap(held, (instance) => instance.call(key, method, args)),
      } satisfies Instances;
    }),
  ) as Layer.Layer<A, E, Exclude<R, A>>;

/**
 * Host a process on objects: each session in an object of its own, on
 * whatever platform provides the `ObjectHost` (`alchemy/Workers/ObjectHost`).
 * Every process the Layer provides gets one class, `AI.<Name>Process`, and
 * every session one object of it, named after the session's key. Each object
 * builds the Layer for itself, so a harness opens on that object's storage.
 *
 * `AICloudflare.layerDurableObjects`, `AIRivet.layerDurableObjects` and
 * `AICluster.layerEntities` are this, given their platform's object host.
 * Use it directly to host a process on an object host of your own.
 *
 * **Example:** Sessions on Rivet, spelled out
 * ```typescript
 * import * as AI from "@alchemy.run/ai";
 * import * as Rivet from "@alchemy.run/rivet";
 * import * as Layer from "effect/Layer";
 *
 * export const EngineerSessions = AI.layerObjects(EngineerLive.pipe(Layer.provide(Agents))).pipe(
 *   Layer.provide(
 *     Rivet.layerObjectHost("Sessions", {
 *       main: import.meta.url,
 *       handler: "EngineerSessions",
 *       pool: Default,
 *     }),
 *   ),
 * );
 * ```
 *
 * @layer
 */
export const layerObjects = <A, E, R>(
  layer: Layer.Layer<A, E, R>,
): Layer.Layer<A, E, Exclude<R, A> | ObjectHost> =>
  make(layer, (name, instance) =>
    Effect.gen(function* () {
      const objects = yield* ObjectHost;
      const namespace = yield* objects.declare(
        `AI.${name}Process`.replace(/[^A-Za-z0-9_.]/g, "_"),
        // Each object builds the process for itself: a harness opens on its storage.
        Effect.map(instance({ apart: true }), ({ call }) => ({ call })),
      );
      return {
        call: (key, method, args) =>
          unwrapDefects(namespace.getByName(key).call!(key, method, args)),
      } satisfies Instances;
    }),
  );
