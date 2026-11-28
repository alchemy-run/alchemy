/**
 * Objects on Rivet: `alchemy/Workers/ObjectHost` on one Durable Object
 * class, which Domain's models and AI's sessions are built on.
 *
 * @module
 */
import { entrypointLayer, entrypointTag } from "alchemy/Runtime/Bootstrap";
import { gateExclusive, InputGate } from "alchemy/Workers/InputGate";
import {
  type ListOptions,
  type Namespace,
  type ObjectImpl,
  ObjectHost,
  ObjectState,
  type ObjectStateShape,
  type ObjectStorage,
  objectName,
  parseObjectName,
  type Stub,
} from "alchemy/Workers/ObjectHost";
import { storageCallbacks } from "alchemy/Workers/StorageCallbacks";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import {
  DurableObject,
  type DurableObjectNamespace,
  type DurableObjectRuntimeContext,
  makeNamespace,
  PlatformDeclaration,
} from "./DurableObject.ts";
import { DurableObjectState, type DurableObjectStorage } from "./DurableObjectState.ts";
import { NodeHost, type PoolHost } from "./Host.ts";
import type { Providers } from "./Providers.ts";
import { upgrade } from "./WebSocket.ts";

/** An object's storage over a Rivet Durable Object's. */
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

/** An object's state over a Rivet Durable Object's. */
const objectState = (
  state: DurableObjectState["Service"],
  storage: ObjectStorage,
): ObjectStateShape => ({
  storage,
  // The instance's input gate, held across the whole section.
  exclusive: (effect) => gateExclusive(effect),
  waitUntil: (effect) => state.waitUntil(effect),
  // The WebSockets the gateway carries to the instance.
  sockets: {
    accept: () => upgrade(),
    all: () => state.getWebSockets(),
  },
});

/** What the class that holds the objects answers. */
interface HostShape {
  readonly alarm: () => Effect.Effect<void>;
  readonly [method: string]: unknown;
}

/** The host class was asked for an object of a class it doesn't hold. */
export class ObjectClassNotHosted extends Data.TaggedError("Rivet.ObjectClassNotHosted")<{
  readonly message: string;
}> {}

/**
 * The class phase of the class that holds the objects: each instance builds
 * the object its name says (`Bank.AccountAggregate/a-1`) from the classes
 * declared on this node.
 */
const hostClassPhase = (name: string, classes: ReadonlyMap<string, ObjectImpl>) =>
  Effect.gen(function* () {
    // Each instance gets Cloudflare's input gate: objects' storage is written for it.
    yield* Layer.buildWithScope(InputGate, yield* Scope.make());
    return Effect.gen(function* () {
      const state = yield* DurableObjectState;
      const parsed = parseObjectName(state.id.name);
      const build = parsed === undefined ? undefined : classes.get(parsed.className);
      if (build === undefined) {
        return yield* Effect.die(
          new ObjectClassNotHosted({
            message: `Rivet.DurableObject '${name}' holds no class for '${state.id.name}'.`,
          }),
        );
      }
      const storage = objectStorage(state.storage);
      const callbacks = storageCallbacks(storage, {
        set: (at) => state.storage.setAlarm(at),
        get: state.storage.getAlarm(),
      });
      const record = yield* build.pipe(
        Effect.provideService(ObjectState, objectState(state, storage)),
        Effect.provide(callbacks.callbacks),
      );
      return { ...record, alarm: () => callbacks.fire } satisfies HostShape;
    });
  });

/** Options for {@link layerObjectHost}. */
export interface ObjectHostOptions<PoolReq> {
  /**
   * The module whose default export is the Layer built on this host,
   * usually `import.meta.url`. The pool's nodes load it to run the objects.
   */
  readonly main: string;
  /** The pool whose nodes run the objects, e.g. `RivetDocker.SwarmPool("Default")`. */
  readonly pool: Layer.Layer<PoolHost, never, PoolReq>;
}

/**
 * Objects on Rivet. Every class declared on it is held by one Durable Object
 * class, `name`: the object `a-1` of the class `Bank.AccountAggregate` is the
 * instance `Bank.AccountAggregate/a-1`, with its own SQLite and alarm.
 *
 * Built in a caller (a Worker, a container), the Layer deploys that class to
 * `pool` and reaches it through the control plane's gateway. The pool's
 * nodes load the Layer built on this one from `main`, and there the same
 * Layer holds the class.
 *
 * It is the entrypoint of everything built on objects: provide it once, to
 * the Layer the module exports as its default. `DomainRivet.layerDurableObjects()`
 * puts a Domain model on it, and `AI.layerObjects` a process's sessions.
 *
 * **Example:** A model and a process's sessions on one class
 * ```typescript
 * import * as AI from "@alchemy.run/ai";
 * import * as DomainRivet from "@alchemy.run/domain/Rivet";
 * import * as Rivet from "@alchemy.run/rivet";
 * import * as RivetDocker from "@alchemy.run/rivet/Docker";
 * import * as Layer from "effect/Layer";
 * import { Agents } from "./Agents.ts";
 * import { Board, IssueWorkLive } from "./Board.model.ts";
 * import { TriageLive } from "./Triage.process.ts";
 *
 * const ControlPlane = RivetDocker.SwarmControlPlane("Rivet");
 * const Default = RivetDocker.SwarmPool("Default").pipe(Layer.provide(ControlPlane));
 *
 * const BoardLive = Board.layer(IssueWorkLive).pipe(Layer.provide(DomainRivet.layerDurableObjects()));
 *
 * const TriageSessions = AI.layerObjects(
 *   TriageLive.pipe(Layer.provide(Layer.mergeAll(Agents, BoardLive))),
 * );
 *
 * export default BoardLive.pipe(
 *   Layer.provideMerge(TriageSessions),
 *   Layer.provide(Rivet.layerObjectHost("App", { main: import.meta.url, pool: Default })),
 * );
 * ```
 *
 * @layer
 * @provides ObjectHost
 */
export const layerObjectHost = <PoolReq>(
  /** The Rivet Durable Object class that holds every object: its actors' name. */
  name: string,
  options: ObjectHostOptions<PoolReq>,
): Layer.Layer<ObjectHost, never, PoolReq | Providers> =>
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the class is declared dynamically; its requirements are the pool's and the providers'
  Layer.effect(
    ObjectHost,
    Effect.gen(function* () {
      const classes = new Map<string, ObjectImpl>();
      const Objects = (DurableObject as any)()(
        name,
        { main: options.main, handler: "default" },
        hostClassPhase(name, classes).pipe(Effect.provide(options.pool)),
      );
      const remote = (namespace: DurableObjectNamespace<any>, cls: string): Namespace => ({
        getByName: (key: string) => namespace.getByName(objectName(cls, key)) as unknown as Stub,
      });
      const node = yield* Effect.serviceOption(NodeHost);
      if (Option.isSome(node)) {
        // A node of the pool: hold the class, as the bootstrap holds an
        // exported one, with the classes declared here.
        const context = yield* Layer.build(entrypointLayer(Objects[PlatformDeclaration]));
        const hosted = (
          Context.get(context, entrypointTag).RuntimeContext as DurableObjectRuntimeContext
        ).hosted();
        if (hosted !== undefined) yield* node.value.host(hosted);
        // Calls between objects go through the control plane, as any
        // caller's do: the object they reach may run on another node.
        const self = makeNamespace(
          name,
          yield* Config.all({
            endpoint: Config.String("RIVET_ENDPOINT").pipe(Config.withDefault("")),
            token: Config.String("RIVET_TOKEN").pipe(Config.withDefault("")),
            namespace: Config.String("RIVET_NAMESPACE").pipe(Config.withDefault("")),
            pool: Config.String("RIVET_POOL").pipe(Config.withDefault("")),
          }).pipe(Effect.orDie),
        );
        return ObjectHost.of({
          name,
          declare: (cls, impl) =>
            Effect.sync(() => {
              classes.set(cls, impl);
              return remote(self, cls);
            }),
          lookup: (cls) => remote(self, cls),
        });
      }
      // A caller: deploy the class, and reach it through the gateway.
      const namespace = (yield* Objects) as DurableObjectNamespace<any>;
      return ObjectHost.of({
        name,
        declare: (cls) => Effect.succeed(remote(namespace, cls)),
        lookup: (cls) => remote(namespace, cls),
      });
    }),
  ) as Layer.Layer<ObjectHost, never, PoolReq | Providers>;
