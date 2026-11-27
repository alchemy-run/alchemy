/**
 * Hosting a process: each of its sessions in an instance of its own.
 *
 * A process's Layer runs every session where it is built. A host takes that
 * Layer and gives back the same process, as a client: `get(key)` is a handle
 * on the instance of that session, which builds the Layer for itself. Where
 * the instances live is the host's: this process's memory
 * ({@link layerInMemory}), or a Durable Object each
 * (`AICloudflare.layerDurableObjects`).
 *
 * @module
 */
import { Callbacks, makeCallback, type Callback } from "alchemy/Callback";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { InstanceSetup } from "alchemy/Workers/InstanceSetup";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import {
  declared,
  HostedTypeId,
  Recorders,
  type DeclaredProcess,
  type Hosted,
  type Sink,
} from "./Process.ts";

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
  /** Run work that outlives the call that started it, for as long as the instance stays up. */
  readonly background: (effect: Effect.Effect<void>) => Effect.Effect<void>;
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

/** How long a session that is not done is left before its reports are looked at again. */
const RECORD_AGAIN = "5 seconds";

/** Who keeps what a session reports, by process. A model that follows one adds itself. */
type Sinks = Map<string, Array<(key: string) => Sink>>;

/** The registry a Layer's build is given, filling `sinks`. */
const recordersInto = (sinks: Sinks): Recorders["Service"] => ({
  add: (name, sink) => {
    const kept = sinks.get(name);
    if (kept === undefined) sinks.set(name, [sink]);
    else kept.push(sink);
  },
});

/** A Layer as it was built, and who keeps what its sessions report. */
interface Built {
  readonly context: Context.Context<unknown>;
  readonly sinks: Sinks;
}

/**
 * One instance of `process`: the sessions it serves, and the recording of
 * what they report. Apart from its host, it builds the Layer for itself.
 */
const instanceOf =
  <A, E, R>(
    process: DeclaredProcess,
    layer: Layer.Layer<A, E, R>,
    /** What the Layer is built with: what the host was given, and each hosted process's client. */
    services: Context.Context<never>,
    /** The Layer as the host built it. */
    local: () => Built,
  ): MakeInstance =>
  ({ background, apart }) =>
    Effect.gen(function* () {
      const hosted = process[HostedTypeId];
      const mutating = new Set(hosted.mutating);
      const own = Effect.gen(function* () {
        const scope = yield* Effect.scope;
        // What the instance itself runs with wins over what the host was given.
        const ambient = yield* Effect.context<never>();
        const setup: Array<Effect.Effect<void, never, RuntimeContext>> = [];
        const sinks: Sinks = new Map();
        // A harness is one per instance, so the Layer is built here, apart from every other build.
        // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- `services` holds what the Layer requires
        const context = yield* Layer.buildWithMemoMap(layer, Layer.makeMemoMapUnsafe(), scope).pipe(
          Effect.provideContext(
            Context.merge(
              services.pipe(
                Context.add(InstanceSetup, { add: (effect) => void setup.push(effect) }),
                Context.add(Recorders, recordersInto(sinks)),
              ),
              Context.omit(InstanceSetup)(ambient),
            ),
          ),
          Effect.orDie,
        ) as Effect.Effect<Context.Context<unknown>>;
        // What a library asked to run once the instance exists: a harness opens here.
        // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- an instance is built inside its runtime
        for (const effect of setup) yield* effect as Effect.Effect<void>;
        return { context, sinks } satisfies Built;
      });
      const built = apart ? yield* own : local();
      const service = Context.getUnsafe(built.context, process as Context.Key<unknown, unknown>);
      const keepers = built.sinks.get(process.processName) ?? [];

      const callbacks = yield* Effect.serviceOption(Callbacks);
      const recorders = new Map<string, ReadonlyArray<ReturnType<Hosted["record"]>>>();
      const recordersOf = (key: string) => {
        let recorder = recorders.get(key);
        if (recorder === undefined) {
          recorders.set(
            key,
            (recorder = keepers.map((sink) => hosted.record(service, key, sink(key)))),
          );
        }
        return recorder;
      };

      const following = new Set<string>();
      /** Follow the session live, once for as long as this instance lives. */
      const follow = (key: string) =>
        Effect.suspend(() => {
          if (following.has(key)) return Effect.void;
          following.add(key);
          // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- an instance's background work runs inside its runtime
          const live = Effect.forEach(
            recordersOf(key),
            (recorder) => Effect.ignore(recorder.live),
            { concurrency: "unbounded", discard: true },
          ).pipe(
            Effect.ensuring(Effect.sync(() => void following.delete(key))),
          ) as Effect.Effect<void>;
          return background(live);
        });

      /**
       * What makes recording durable where an instance can be evicted: a job
       * on its alarm, kept in its storage. It wakes the instance, keeps what
       * was stored meanwhile, and comes back until the session is done.
       */
      let onRecord: Callback<string> | undefined;
      const again = (key: string): Effect.Effect<void, never, RuntimeContext> =>
        onRecord === undefined
          ? Effect.void
          : onRecord.schedule(key, { after: RECORD_AGAIN, payload: key }).pipe(Effect.orDie);
      if (Option.isSome(callbacks) && keepers.length > 0) {
        onRecord = yield* makeCallback(
          `record-${process.processName}`,
          Effect.fn(function* (key: string) {
            yield* follow(key);
            const done = yield* Effect.forEach(recordersOf(key), (recorder) => recorder.catchUp);
            if (!done.every((each) => each)) yield* again(key);
          }, Effect.orDie),
        ).pipe(Effect.provideService(Callbacks, callbacks.value));
      }
      /** Record from now until the session is done. */
      const record = (key: string) =>
        keepers.length === 0 ? Effect.void : Effect.andThen(follow(key), again(key));

      const methods = new Map<string, ReturnType<Hosted["serve"]>>();
      return {
        call: (key, method, args) =>
          Effect.suspend(() => {
            let served = methods.get(key);
            if (served === undefined) methods.set(key, (served = hosted.serve(service, key)));
            const run = served[method];
            if (run === undefined) {
              return Effect.die(new Error(`${process.processName} has no method ${method}`));
            }
            return mutating.has(method)
              ? Effect.tap(run(...args), () => record(key))
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
 * @internal For hosts: `layerInMemory`, `AICloudflare.layerDurableObjects`.
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
      let local: Built | undefined;
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
            () => Context.getUnsafe(local!.context, process as Context.Key<unknown, unknown>),
          ) as never,
        );
      }
      const services = Context.merge(given, clients);
      const sinks: Sinks = new Map();
      // Built once here too, with the Layers around it: what it binds at
      // deploy is bound, and a model it is given is the one everything else
      // is given.
      const built = (yield* Layer.buildWithMemoMap(layer, memoMap, scope).pipe(
        Effect.provideContext(Context.add(services, Recorders, recordersInto(sinks))),
      )) as Context.Context<unknown>;
      local = { context: built, sinks };
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
 * const Live = BoardInMemory.pipe(Layer.provide(TriageInMemory));
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
            : instance({
                apart: false,
                background: (effect) => Effect.asVoid(Effect.forkIn(effect, scope)),
              }).pipe(
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
