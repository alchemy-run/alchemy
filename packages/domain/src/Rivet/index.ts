import {
  DurableObject,
  type DurableObjectNamespace,
  type DurableObjectRuntimeContext,
  makeNamespace,
  PlatformDeclaration,
} from "@alchemy.run/rivet/DurableObject";
import {
  DurableObjectState,
  type DurableObjectStorage,
} from "@alchemy.run/rivet/DurableObjectState";
import { NodeHost, type PoolHost } from "@alchemy.run/rivet/Host";
import type { Providers } from "@alchemy.run/rivet/Providers";
import { upgrade } from "@alchemy.run/rivet/WebSocket";
import type { HttpEffect } from "alchemy/Http";
import { entrypointLayer, entrypointTag } from "alchemy/Runtime/Bootstrap";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { makeDurableObjectEngine } from "alchemy/Workers/DurableObjectEngine";
import { gateExclusive, InputGate } from "alchemy/Workers/InputGate";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import type { WorkflowEngine } from "effect/workflow";
/**
 * Host a domain model (`@alchemy.run/domain`) on Rivet Durable Objects.
 *
 * @module
 */
import {
  alarmCallbacks,
  type Attachment,
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
  SUBSCRIPTION_HEADER,
} from "../DurableObjects.ts";
import type { Platform, Subscription } from "../Platform.ts";

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
  // Live reads hold the WebSockets the gateway carries to the instance.
  sockets: {
    accept: () => upgrade(),
    all: () => state.getWebSockets(),
  },
});

/**
 * Forward a live read's WebSocket upgrade (the current request) to the
 * instance that owns `key`, carrying the subscription. The caller sets the
 * header, overwriting any a client sent, so the instance can trust it.
 */
const connectTo = (namespace: Namespace, key: string, subscription: Subscription): HttpEffect =>
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- erases RuntimeContext, which the caller's runtime provides at call time
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const forwarded = request.modify({
      headers: Headers.set(
        request.headers,
        SUBSCRIPTION_HEADER,
        JSON.stringify({ key, subscription } satisfies Attachment),
      ),
    });
    const stub = namespace.getByName(key) as unknown as ReturnType<
      DurableObjectNamespace<{}>["getByName"]
    >;
    return yield* stub.fetch(forwarded).pipe(Effect.orDie);
  }) as HttpEffect;

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
    connect: connectTo,
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

/** Options for {@link layerDurableObjects}. */
export interface DurableObjectsOptions<PoolReq> {
  /** The Rivet Durable Object class that hosts the model: its actors' name. */
  readonly name: string;
  /**
   * The module that exports the model's Layer (the one this platform is
   * provided to), usually `import.meta.url`. The pool's nodes load it to run
   * the model.
   */
  readonly main: string;
  /**
   * The export of {@link main} that holds the model's Layer.
   * @default "default"
   */
  readonly handler?: string;
  /** The pool whose nodes run the model, e.g. `RivetDocker.SwarmPool("Default")`. */
  readonly pool: Layer.Layer<PoolHost, never, PoolReq>;
}

/**
 * The class phase of the class that hosts a model: each instance builds the
 * object its name says (`Bank.AccountAggregate/a-1`) from the classes the
 * model declared on this node.
 */
const hostClassPhase = (name: string, classes: ReadonlyMap<string, InstanceBuild>) =>
  Effect.gen(function* () {
    // Each instance gets Cloudflare's input gate: the objects' storage was
    // written for it.
    yield* Layer.buildWithScope(InputGate, yield* Scope.make());
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
      return { ...record, alarm: () => callbacks.fire } satisfies DomainShape;
    });
  });

/**
 * Host a domain model on Rivet Durable Objects. Provide it to the model's
 * Layer, as `Domain.InMemory` or `DomainCloudflare.layerDurableObjects()` would be, in
 * every runtime that serves the model: a Worker, a Lambda, a container.
 *
 * The model's aggregate instances, view keys, policies and saga runs are
 * instances of one Durable Object class, `name`, each named after what it
 * holds (`Bank.AccountAggregate/a-1`). Built in a caller, the Layer deploys
 * that class to `pool` and reaches it through the control plane's gateway.
 * The pool's nodes load the model's Layer from `main`, and there the same
 * Layer hosts the class.
 *
 * Commands to one aggregate instance run one at a time. Events, state and
 * the outbox commit together in the instance's SQLite, and deliveries to
 * views, projections and policies are at least once and in order per source.
 * Scheduled commands and retries are the instance's alarm. Over
 * `Domain.protocolWebSocket`, a live read's WebSocket travels through the
 * control plane's gateway to the instance that owns the key, which pushes
 * every commit down it. Over `Domain.protocolHttp`, live reads are streamed
 * responses that poll the owning instance.
 *
 * ### Hosting a model on Rivet
 * **Example:** The model's Layer, served from a Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as RivetDocker from "@alchemy.run/rivet/Docker";
 * import * as DomainRivet from "@alchemy.run/domain/Rivet";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import { Bank, BankHandlers } from "./Bank.model.ts";
 * import { CustomerApi } from "./CustomerApi.api.ts";
 *
 * const ControlPlane = RivetDocker.SwarmControlPlane("Rivet");
 * const Default = RivetDocker.SwarmPool("Default").pipe(Layer.provide(ControlPlane));
 *
 * export const BankLive = Bank.layer(BankHandlers).pipe(
 *   Layer.provide(
 *     DomainRivet.layerDurableObjects({
 *       name: "Bank",
 *       main: import.meta.url,
 *       handler: "BankLive",
 *       pool: Default,
 *     }),
 *   ),
 * );
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
export const layerDurableObjects = <PoolReq>(
  options: DurableObjectsOptions<PoolReq>,
): Layer.Layer<
  Platform | WorkflowEngine.WorkflowEngine | SecureRandom.SecureRandom,
  never,
  PoolReq | Providers
> =>
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the class is declared dynamically; its requirements are the pool's and the providers'
  Layer.unwrap(
    Effect.gen(function* () {
      const classes = new Map<string, InstanceBuild>();
      const Objects = (DurableObject as any)()(
        options.name,
        { main: options.main, handler: options.handler ?? "default" },
        hostClassPhase(options.name, classes).pipe(Effect.provide(options.pool)),
      );
      const node = yield* Effect.serviceOption(NodeHost);
      if (Option.isSome(node)) {
        // A node of the pool: host the class, as the bootstrap hosts an
        // exported one, with the classes the model declares here.
        const context = yield* Layer.build(entrypointLayer(Objects[PlatformDeclaration]));
        const hosted = (
          Context.get(context, entrypointTag).RuntimeContext as DurableObjectRuntimeContext
        ).hosted();
        if (hosted !== undefined) yield* node.value.host(hosted);
        // Calls between the model's objects go through the control plane, as
        // any caller's do: the object they reach may run on another node.
        const self = makeNamespace(
          options.name,
          yield* Config.all({
            endpoint: Config.String("RIVET_ENDPOINT").pipe(Config.withDefault("")),
            token: Config.String("RIVET_TOKEN").pipe(Config.withDefault("")),
            namespace: Config.String("RIVET_NAMESPACE").pipe(Config.withDefault("")),
            pool: Config.String("RIVET_POOL").pipe(Config.withDefault("")),
          }).pipe(Effect.orDie),
        );
        return multiplexed(options.name, self, (cls, build) => classes.set(cls, build));
      }
      // A caller: deploy the class, and reach it through the gateway.
      const namespace = (yield* Objects) as DurableObjectNamespace<any>;
      return multiplexed(options.name, namespace, () => undefined);
    }),
  ) as Layer.Layer<
    Platform | WorkflowEngine.WorkflowEngine | SecureRandom.SecureRandom,
    never,
    PoolReq | Providers
  >;
