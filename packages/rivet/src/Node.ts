/**
 * Durable Objects in a process Alchemy didn't build, such as an existing
 * server that joins a pool as one of its nodes, or a test. `serve` hosts
 * classes on a pool of a control plane; `connect` reaches any class's
 * instances through the gateway.
 *
 * ```typescript
 * import * as RivetNode from "@alchemy.run/rivet/Node";
 * ```
 */
import { entrypointLayer, entrypointTag, stackConstant } from "alchemy/Runtime/Bootstrap";
import { Stack } from "alchemy/Stack";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import {
  actorOptionsOf,
  DurableObjectHasNoPool,
  namespaceAt,
  PlatformDeclaration,
  type DurableObjectRuntimeContext,
} from "./DurableObject.ts";
import { runDurableObjects } from "./internal/Runtime.ts";

/**
 * A control plane, the namespace its instances live in, and the pool that
 * hosts them. Each field left out is read from the environment, the
 * variables a pool sets on the nodes Alchemy builds.
 */
export interface NodeConnection {
  /**
   * The control plane URL.
   * @default Config.String("RIVET_ENDPOINT")
   */
  readonly endpoint?: string;
  /**
   * The token nodes and callers present to the control plane.
   * @default Config.Redacted("RIVET_TOKEN")
   */
  readonly token?: Redacted.Redacted<string>;
  /**
   * The control plane namespace.
   * @default Config.String("RIVET_NAMESPACE")
   */
  readonly namespace?: string;
  /**
   * The pool this node joins, and where callers create instances.
   * @default Config.String("RIVET_POOL")
   */
  readonly pool?: string;
}

/** Where {@link connect} sends its calls. */
export interface ConnectOptions extends NodeConnection {
  /** Headers added to every call, computed when it is sent, such as the caller's trace. A header the call sets itself wins. */
  readonly headers?: () => ReadonlyArray<readonly [string, string]>;
}

/** Where a node connects, and how its RivetKit registry runs. */
export interface ServeOptions extends NodeConnection {
  /** Further RivetKit registry settings, such as message size limits. */
  readonly registry?: Readonly<Record<string, unknown>>;
  /**
   * RivetKit actor options by class (its `LogicalId`), in milliseconds,
   * such as `sleepGracePeriod`. Each wins over the same option the class
   * sets in its props; an option neither sets keeps RivetKit's default.
   */
  readonly options?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * How the registry shuts down. The process owns its signals, so the
   * registry never installs signal handlers; `gracePeriodMs` is how long it
   * waits for its actors before it closes.
   */
  readonly shutdown?: { readonly gracePeriodMs?: number };
  /** Runs once the node is registered with the control plane. */
  readonly connected?: Effect.Effect<void>;
}

/** A `Rivet.DurableObject` class, as `Rivet.DurableObject<…>()(…)` declares it. */
export interface DurableObjectClass<Shape> {
  readonly LogicalId: string;
  new (_: never): Shape;
}

/** Each field of `given`, or the environment variable it defaults to. */
const resolveConnection = Effect.fn(function* (given: NodeConnection) {
  return {
    endpoint: given.endpoint ?? (yield* Config.String("RIVET_ENDPOINT")),
    token: Redacted.value(given.token ?? (yield* Config.Redacted("RIVET_TOKEN"))),
    namespace: given.namespace ?? (yield* Config.String("RIVET_NAMESPACE")),
    pool: given.pool ?? (yield* Config.String("RIVET_POOL")),
  };
});

/**
 * Run each class's outer Effect once, with the caller's context, as the
 * runtime phase does on a node Alchemy built. A process Alchemy did not
 * build has no stack, so the classes get one named for it.
 */
const host = (classes: ReadonlyArray<DurableObjectClass<unknown>>) =>
  Effect.forEach(classes, (entrypoint) =>
    Effect.gen(function* () {
      const declaration =
        (entrypoint as { [PlatformDeclaration]?: unknown })[PlatformDeclaration] ?? entrypoint;
      const entry = entrypointLayer(declaration);
      const stack = yield* Effect.serviceOption(Stack);
      const context = yield* Layer.build(
        Option.isSome(stack) ? entry : entry.pipe(Layer.provide(stackConstant("rivet", "node"))),
      );
      const self = Context.get(context, entrypointTag);
      const runtime = self.RuntimeContext as DurableObjectRuntimeContext;
      const built = runtime.hosted();
      if (built !== undefined) {
        return { built, options: yield* actorOptionsOf(runtime.id, self.Props) };
      }
      return yield* Effect.die(
        new DurableObjectHasNoPool({
          message: `Rivet.DurableObject '${runtime.id}' did not finish its class phase.`,
        }),
      );
    }),
  );

/** Run `effect` in the runtime phase, then put the flag back as it was. */
const inRuntimePhase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = globalThis.__ALCHEMY_RUNTIME__;
      globalThis.__ALCHEMY_RUNTIME__ = true;
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        globalThis.__ALCHEMY_RUNTIME__ = previous;
      }),
  );

/**
 * Host `classes` in this process as a node of the pool until the returned
 * Effect is interrupted. Each class's outer Effect runs once, here, with
 * this Effect's context: provide the services the classes yield.
 */
export const serve = (
  classes: ReadonlyArray<DurableObjectClass<unknown>>,
  options: ServeOptions = {},
) =>
  Effect.gen(function* () {
    const connection = yield* resolveConnection(options);
    const hosted = yield* inRuntimePhase(host(classes));
    return yield* runDurableObjects(
      hosted.map(({ built }) => built),
      // What a class sets in its props, under what `options` sets for it.
      Object.fromEntries(
        hosted.flatMap(({ built, options: declared }) => {
          const merged = { ...declared, ...options.options?.[built.name] };
          return Object.keys(merged).length === 0 ? [] : [[built.name, merged]];
        }),
      ),
      {
        ...connection,
        registry: options.registry,
        shutdown: options.shutdown,
        connected: options.connected,
      },
    );
  }) satisfies Effect.Effect<never, Config.ConfigError, Scope.Scope>;

/** Reach the instances of any Durable Object class through the gateway. */
export const connect = Effect.fn(function* <Shape>(
  object: DurableObjectClass<Shape>,
  options: ConnectOptions = {},
) {
  const connection = yield* resolveConnection(options);
  return namespaceAt<Shape>(object.LogicalId, { ...connection, headers: options.headers });
});
