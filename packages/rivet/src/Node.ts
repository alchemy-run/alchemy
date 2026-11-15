/**
 * Durable Objects in a process Alchemy didn't build, such as an existing
 * server that joins a pool as one of its nodes, or a test. `serve` hosts
 * classes on a pool of a control plane; `connect` reaches any class's
 * instances through the gateway.
 */
import { entrypointLayer, entrypointTag, stackConstant } from "alchemy/Runtime/Bootstrap";
import { Stack } from "alchemy/Stack";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import {
  DurableObjectHasNoPool,
  namespaceAt,
  PlatformDeclaration,
  type DurableObjectNamespace,
  type DurableObjectRuntimeContext,
} from "./DurableObject.ts";
import { runDurableObjects } from "./internal/Runtime.ts";

/** A control plane, the namespace its instances live in, and the pool that hosts them. */
export interface NodeConnection {
  /** The control plane URL. */
  readonly endpoint: string;
  /** The token nodes and callers present to the control plane. */
  readonly token: Redacted.Redacted<string>;
  readonly namespace: string;
  /** The pool this node joins, and where callers create instances. */
  readonly pool: string;
  /** Headers {@link connect} adds to every call, computed when it is sent: the caller's trace. */
  readonly headers?: (() => ReadonlyArray<readonly [string, string]>) | undefined;
}

/** A `Rivet.DurableObject` class, as `Rivet.DurableObject<…>()(…)` declares it. */
export interface DurableObjectClass<Shape> {
  readonly LogicalId: string;
  new (_: never): Shape;
}

/** How a node's RivetKit registry runs. */
export interface ServeOptions {
  /** Further RivetKit registry settings, such as message size limits. */
  readonly registry?: Readonly<Record<string, unknown>>;
  /**
   * RivetKit actor options by class (its `LogicalId`), such as
   * `sleepGracePeriod`. A class not listed runs with RivetKit's defaults.
   */
  readonly options?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * How the registry shuts down. The node owns the process signals, so
   * `disableSignalHandlers` is always set; `gracePeriodMs` is how long the
   * registry waits for its actors before it closes.
   */
  readonly shutdown?: { readonly gracePeriodMs?: number };
  /** Runs once the node is registered with the control plane. */
  readonly connected?: Effect.Effect<void>;
}

/**
 * Run each class's outer Effect once, with the caller's context. A process
 * Alchemy did not build has no stack, so the classes get one named for it.
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
      const runtime = Context.get(context, entrypointTag)
        .RuntimeContext as DurableObjectRuntimeContext;
      const built = runtime.hosted();
      if (built !== undefined) return built;
      return yield* Effect.die(
        new DurableObjectHasNoPool({
          message: `Rivet.DurableObject '${runtime.id}' did not finish its class phase.`,
        }),
      );
    }),
  );

/**
 * Host `classes` in this process as a node of `connection.pool` until the
 * returned Effect is interrupted. Each class's outer Effect runs once, here,
 * with this Effect's context: provide the services the classes yield.
 */
export const serve = (
  classes: ReadonlyArray<DurableObjectClass<unknown>>,
  connection: NodeConnection,
  options: ServeOptions = {},
): Effect.Effect<never, never, Scope.Scope> =>
  Effect.gen(function* () {
    globalThis.__ALCHEMY_RUNTIME__ = true;
    const hosted = yield* host(classes);
    return yield* runDurableObjects(hosted, {
      endpoint: connection.endpoint,
      token: Redacted.value(connection.token),
      namespace: connection.namespace,
      pool: connection.pool,
      registry: options.registry,
      options: options.options,
      shutdown: options.shutdown,
      connected: options.connected,
    });
  }) as Effect.Effect<never, never, Scope.Scope>;

/** Reach the instances of any Durable Object class through the gateway. */
export const connect =
  (connection: NodeConnection) =>
  <Shape>(object: DurableObjectClass<Shape>): DurableObjectNamespace<Shape> =>
    namespaceAt<Shape>(object.LogicalId, {
      endpoint: connection.endpoint,
      token: Redacted.value(connection.token),
      namespace: connection.namespace,
      pool: connection.pool,
      headers: connection.headers,
    });
