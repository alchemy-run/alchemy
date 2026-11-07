/**
 * Host a domain model (`@alchemy.run/domain`) on Rivet Durable Objects.
 *
 * @module
 */
import {
  alarmCallbacks,
  className,
  type Host,
  type ListOptions,
  makePlatform,
  type Namespace,
  type ObjectImpl,
  ObjectState,
  type ObjectStateShape,
  type ObjectStorage,
  parseMultiplexedName,
  type Stub,
} from "@alchemy.run/domain/DurableObjects";
import type { Platform } from "@alchemy.run/domain/Platform";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { makeDurableObjectEngine } from "alchemy/Workers/DurableObjectEngine";
import { gateExclusive, InputGate } from "alchemy/Workers/InputGate";
import * as Config from "effect/Config";
import type * as ConfigError from "effect/Config";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { WorkflowEngine } from "effect/workflow";
import {
  DurableObjectTypeId,
  makeNamespace,
  type DurableObjectNamespace,
  type InstanceServices,
} from "../DurableObject.ts";
import { DurableObjectState, type DurableObjectStorage } from "../DurableObjectState.ts";

/** Built for one instance: an object's methods. */
type InstanceBuild = Effect.Effect<
  Record<string, unknown>,
  never,
  EngineState | ObjectState | RuntimeContext | Scope.Scope
>;

/** Domain's storage over a Rivet Durable Object's. */
const objectStorage = (storage: DurableObjectStorage): ObjectStorage => {
  const put = (keyOrEntries: string | Record<string, unknown>, value?: unknown) =>
    typeof keyOrEntries === "string"
      ? storage.put(keyOrEntries, value)
      : Effect.forEach(Object.entries(keyOrEntries), ([key, entry]) => storage.put(key, entry), {
          discard: true,
        });
  const del = (keyOrKeys: string | ReadonlyArray<string>) =>
    typeof keyOrKeys === "string"
      ? storage.delete(keyOrKeys)
      : Effect.map(
          Effect.forEach(keyOrKeys, (key) => storage.delete(key)),
          (deleted) => deleted.filter(Boolean).length,
        );
  return {
    get: (key) => storage.get(key),
    put: put as ObjectStorage["put"],
    delete: del as ObjectStorage["delete"],
    // Rivet lists from `start`; a key just after `startAfter` is where that starts.
    list: <T>({ startAfter, start, ...options }: ListOptions = {}) =>
      storage.list<T>({
        ...options,
        ...(start !== undefined || startAfter !== undefined
          ? {
              start:
                startAfter === undefined
                  ? start
                  : start === undefined || `${startAfter}\u0000` > start
                    ? `${startAfter}\u0000`
                    : start,
            }
          : {}),
      }),
    transaction: (effect) => storage.transaction(effect),
  };
};

/** The SQL storage the workflow engine journals each saga run in. */
interface EngineStateShape {
  readonly storage: {
    readonly sql: {
      exec<T extends Record<string, unknown>>(
        query: string,
        ...bindings: ReadonlyArray<unknown>
      ): Effect.Effect<{ toArray(): Effect.Effect<T[]> }>;
    };
    readonly transaction: DurableObjectStorage["transaction"];
  };
}

/** A run's instance state, as the workflow engine reads it. */
class EngineState extends Context.Service<EngineState, EngineStateShape>()(
  "Rivet/Domain/EngineState",
) {}

/**
 * The engine's SQL over a Rivet instance's database: its schema arrives as
 * one script, and RivetKit runs one statement per call.
 */
const engineState = (state: DurableObjectState["Service"]): EngineStateShape => ({
  storage: {
    sql: {
      exec: <T extends Record<string, unknown>>(
        query: string,
        ...bindings: ReadonlyArray<unknown>
      ) => {
        const statements = query
          .split(";")
          .map((statement) => statement.trim())
          .filter((statement) => statement.length > 0);
        if (statements.length <= 1) return state.storage.sql.exec<T>(query, ...bindings);
        return Effect.forEach(statements, (statement) => state.storage.sql.exec<T>(statement)).pipe(
          Effect.map((cursors) => cursors[cursors.length - 1]!),
        );
      },
    },
    transaction: (effect, options) => state.storage.transaction(effect, options),
  },
});

/** Domain's view of a Rivet Durable Object's state. */
const objectState = (
  state: DurableObjectState["Service"],
  storage: ObjectStorage,
): ObjectStateShape => ({
  storage,
  // The instance's input gate, held across the whole section.
  exclusive: (effect) => gateExclusive(effect),
  waitUntil: (effect) => state.waitUntil(effect),
});

/** What a Domain host class's instance returns. */
export interface DomainShape {
  readonly alarm: () => Effect.Effect<void>;
  readonly [method: string]: unknown;
}

/** A Domain host class was asked for an object of a class it doesn't host. */
export class DomainClassNotHosted extends Data.TaggedError("Rivet.DomainClassNotHosted")<{
  readonly message: string;
}> {}

/** The class names this host class claims, keyed by its id. */
const claims = new Map<string, object>();
const claimOf = (name: string) => {
  let claim = claims.get(name);
  if (claim === undefined) claims.set(name, (claim = {}));
  return claim;
};

/**
 * Every class of a model on one Rivet class: the object `Bank.AccountAggregate`
 * named `a-1` is the instance `Bank.AccountAggregate/a-1`. `declare` hands the
 * class's implementation to `onDeclare`, which keeps it where the class runs.
 */
const multiplexed = (
  name: string,
  namespace: DurableObjectNamespace<any>,
  onDeclare: (className: string, build: InstanceBuild) => void,
) => {
  const remote = (cls: string): Namespace => ({
    getByName: (key: string) => namespace.getByName(`${cls}/${key}`) as unknown as Stub,
  });
  const host: Host = {
    declare: ({ modelName }, cls, impl: ObjectImpl) =>
      Effect.sync(() => {
        onDeclare(className(modelName, cls), impl);
        return remote(className(modelName, cls));
      }),
    lookup: ({ modelName }, cls) => remote(className(modelName, cls)),
    claimKey: Effect.succeed(claimOf(name)),
  };
  // Sagas run on the workflow engine over the same class: each execution
  // is the instance `<Workflow>/<executionId>`, its journal in that
  // instance's SQLite.
  const engine = makeDurableObjectEngine({
    declare: (cls, impl) =>
      Effect.sync(() => {
        // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- an instance provides the engine's state, its own state and its RuntimeContext
        onDeclare(cls, Effect.flatten(impl) as InstanceBuild);
        return remote(cls) as never;
      }),
    // The engine reads only `toArray` from its cursors, which Rivet's have.
    state: EngineState as never,
  });
  return Layer.merge(makePlatform(host), engine).pipe(
    // The model's Layer needs it too.
    Layer.provideMerge(SecureRandom.layerWebCrypto),
  );
};

/**
 * The class phase of a Rivet Durable Object that hosts a domain model: every
 * aggregate instance, view key, policy and saga run of the model is one
 * instance of this class, named after it (`Bank.AccountAggregate/a-1`).
 * Pass the model's Layer, with the services its policies and projections
 * need, and provide a pool Layer to the class as usual.
 *
 * Commands to one aggregate instance run one at a time. Events, state and
 * the outbox commit together in the instance's SQLite, and deliveries to
 * views, projections and policies are at least once and in order per source.
 * Scheduled commands and retries are the instance's alarm. Live reads are
 * streamed responses that poll the owning instance: Rivet 3 has no
 * hibernatable WebSockets.
 *
 * Callers reach the model through {@link layer}.
 *
 * ### Hosting a model on Rivet
 * **Example:** The class that runs the model on a pool
 * ```typescript
 * import * as Rivet from "@alchemy.run/rivet";
 * import * as RivetDocker from "@alchemy.run/rivet/Docker";
 * import * as DomainRivet from "@alchemy.run/rivet/Domain";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import { Bank, BankHandlers } from "./Bank.model.ts";
 *
 * export const ControlPlane = RivetDocker.SwarmControlPlane("Rivet");
 * export const Default = RivetDocker.SwarmPool("Default").pipe(Layer.provide(ControlPlane));
 *
 * export default class BankObjects extends Rivet.DurableObject<BankObjects>()(
 *   "Bank",
 *   { main: import.meta.url },
 *   DomainRivet.host(Bank.layer(BankHandlers)).pipe(Effect.provide(Default)),
 * ) {}
 * ```
 *
 * @primitive
 */
export const host = <ROut, E, RIn>(
  model: Layer.Layer<ROut, E, RIn>,
): Effect.Effect<
  Effect.Effect<DomainShape, never, InstanceServices>,
  ConfigError.ConfigError,
  | Exclude<RIn, Platform | WorkflowEngine.WorkflowEngine | SecureRandom.SecureRandom>
  | RuntimeContext
> =>
  Effect.gen(function* () {
    const ctx = yield* RuntimeContext;
    if (ctx.Type !== DurableObjectTypeId) {
      return yield* Effect.die(
        new Error("DomainRivet.host is the class phase of a Rivet.DurableObject."),
      );
    }
    const name = ctx.id;
    // Calls between the model's objects go through the control plane, as
    // any caller's do: the object they reach may run on another node.
    const self = makeNamespace(
      name,
      yield* Config.all({
        endpoint: Config.String("RIVET_ENDPOINT").pipe(Config.withDefault("")),
        token: Config.String("RIVET_TOKEN").pipe(Config.withDefault("")),
        namespace: Config.String("RIVET_NAMESPACE").pipe(Config.withDefault("")),
        pool: Config.String("RIVET_POOL").pipe(Config.withDefault("")),
      }),
    );
    const classes = new Map<string, InstanceBuild>();
    // Lives as long as the node: the model's Layer is the class's.
    const scope = yield* Scope.make();
    // Each instance gets Cloudflare's input gate: the objects' storage was
    // written for it.
    yield* Layer.buildWithScope(InputGate, scope);
    yield* Layer.buildWithScope(
      model.pipe(Layer.provide(multiplexed(name, self, (cls, build) => classes.set(cls, build)))),
      scope,
    ).pipe(Effect.orDie);

    return Effect.gen(function* () {
      const state = yield* DurableObjectState;
      const parsed = parseMultiplexedName(state.id.name);
      const build = parsed === undefined ? undefined : classes.get(parsed.className);
      if (build === undefined) {
        return yield* Effect.die(
          new DomainClassNotHosted({
            message: `Rivet.DurableObject '${name}' hosts no Domain class for '${state.id.name}'.`,
          }),
        );
      }
      const storage = objectStorage(state.storage);
      const callbacks = alarmCallbacks(storage, {
        set: (at) => state.storage.setAlarm(at),
        get: state.storage.getAlarm(),
      });
      const runtime = yield* RuntimeContext;
      const record = yield* build.pipe(
        Effect.provideService(ObjectState, objectState(state, storage)),
        Effect.provideService(EngineState, engineState(state)),
        Effect.provideService(RuntimeContext, { ...runtime, makeCallback: callbacks.makeCallback }),
      );
      // Rivet 3 holds no WebSockets: live reads poll.
      const {
        fetch: _fetch,
        webSocketMessage: _m,
        webSocketClose: _c,
        webSocketError: _e,
        ...methods
      } = record;
      return { ...methods, alarm: () => callbacks.fire } satisfies DomainShape;
    });
  }) as Effect.Effect<
    Effect.Effect<DomainShape, never, InstanceServices>,
    ConfigError.ConfigError,
    | Exclude<RIn, Platform | WorkflowEngine.WorkflowEngine | SecureRandom.SecureRandom>
    | RuntimeContext
  >;

/**
 * The Domain platform for code that calls a model hosted by {@link host}:
 * a Worker, a Lambda, a container, another Durable Object. Provide it to the
 * model's Layer, as `Domain.InMemory` or `layerDurableObjects()` would be.
 * Commands, reads and saga runs go to the model's instances through the
 * control plane's gateway.
 *
 * ### Calling a model on Rivet
 * **Example:** A Worker serving an Api over the Rivet-hosted model
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as DomainRivet from "@alchemy.run/rivet/Domain";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import { Bank, BankHandlers } from "./Bank.model.ts";
 * import BankObjects from "./BankObjects.ts";
 * import { CustomerApi } from "./CustomerApi.api.ts";
 *
 * const BankLive = Bank.layer(BankHandlers).pipe(Layer.provide(DomainRivet.layer(BankObjects)));
 *
 * export default class BankWorker extends Cloudflare.Worker<BankWorker>()(
 *   "BankWorker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const api = yield* CustomerApi;
 *     return { fetch: api.fetch };
 *   }).pipe(Effect.provide(BankLive)),
 * ) {}
 * ```
 *
 * @layer
 * @provides Domain.Platform
 * @provides WorkflowEngine
 */
export const layer = <R>(
  objects: Effect.Effect<DurableObjectNamespace<any>, never, R>,
): Layer.Layer<Platform | WorkflowEngine.WorkflowEngine | SecureRandom.SecureRandom, never, R> =>
  Layer.unwrap(
    Effect.map(objects, (namespace) => multiplexed(namespace.name, namespace, () => undefined)),
  ) as Layer.Layer<Platform | WorkflowEngine.WorkflowEngine | SecureRandom.SecureRandom, never, R>;
