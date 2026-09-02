/**
 * The engine-invariant Durable Object core shared by the Cloudflare, Celld
 * and Rivet bridges: the per-instance `DurableObjectState` contract, the
 * shape an instance exports, the export record a hosting worker publishes
 * for each class, and the hosting core that registers a class on its host
 * (binding + runtime-namespace resolution + class export).
 *
 * Per-engine variation rides on the host (see {@link DurableObjectHostLike});
 * nothing here imports an engine runtime.
 *
 * @internal
 */
import type * as cf from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Binding from "../Binding.ts";
import type { HttpEffect } from "../Http.ts";
import type { Input } from "../Input.ts";
import { ALCHEMY_PHASE } from "../Phase.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import {
  fromDurableObjectStorage,
  type DurableObjectStorage,
} from "./DurableObjectStorage.ts";
import { fromWebSocket, type WebSocket } from "./WebSocket.ts";
import { WorkerEnvironment } from "./Worker.ts";

export type AlarmInvocationInfo = cf.AlarmInvocationInfo;

// ---------------------------------------------------------------------------
// DurableObjectState — the per-instance state service
// ---------------------------------------------------------------------------

export class DurableObjectState extends Context.Service<
  DurableObjectState,
  {
    readonly id: cf.DurableObjectId;
    readonly storage: DurableObjectStorage;
    container?: cf.Container;
    /**
     * Run an Effect in the background without blocking the current event,
     * keeping the Durable Object alive until it settles. The Effect runs with
     * the caller's full context (services, tracing), and the resulting
     * promise is registered with the engine's `state.waitUntil`.
     */
    waitUntil<A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<void, never, R | RuntimeContext>;
    /**
     * The raw engine DurableObjectState, for interop with async APIs.
     */
    readonly raw: cf.DurableObjectState;
    blockConcurrencyWhile<T>(
      callback: () => Effect.Effect<T, never, RuntimeContext>,
    ): Effect.Effect<T, never, RuntimeContext>;
    acceptWebSocket(
      ws: WebSocket,
      tags?: string[],
    ): Effect.Effect<void, never, RuntimeContext>;
    getWebSockets(
      tag?: string,
    ): Effect.Effect<WebSocket[], never, RuntimeContext>;
    setWebSocketAutoResponse(
      maybeReqResp?: cf.WebSocketRequestResponsePair,
    ): Effect.Effect<void, never, RuntimeContext>;
    getWebSocketAutoResponse(): Effect.Effect<
      cf.WebSocketRequestResponsePair | null,
      never,
      RuntimeContext
    >;
    getWebSocketAutoResponseTimestamp(
      ws: cf.WebSocket,
    ): Effect.Effect<Date | null, never, RuntimeContext>;
    setHibernatableWebSocketEventTimeout(
      timeoutMs?: number,
    ): Effect.Effect<void, never, RuntimeContext>;
    getHibernatableWebSocketEventTimeout(): Effect.Effect<
      number | null,
      never,
      RuntimeContext
    >;
    getTags(ws: cf.WebSocket): Effect.Effect<string[], never, RuntimeContext>;
    abort(reason?: string): Effect.Effect<void, never, RuntimeContext>;
  }
>()("Cloudflare.DurableObjectState") {}

export const fromDurableObjectState = (
  state: cf.DurableObjectState,
): DurableObjectState["Service"] => ({
  id: state.id,
  container: state.container,
  storage: fromDurableObjectStorage(state.storage),
  raw: state,
  waitUntil: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<R>();
      // Register the promise with the engine un-awaited — waitUntil extends
      // the event's lifetime without blocking the caller.
      yield* Effect.sync(() =>
        state.waitUntil(
          Effect.runPromise(effect.pipe(Effect.provide(context))),
        ),
      );
    }),
  blockConcurrencyWhile: <T>(callback: () => Effect.Effect<T>) =>
    Effect.tryPromise(() =>
      state.blockConcurrencyWhile(() => Effect.runPromise(callback())),
    ),
  acceptWebSocket: (ws: WebSocket, tags?: string[]) =>
    Effect.sync(() => state.acceptWebSocket(ws.ws, tags)),
  getWebSockets: (tag?: string) =>
    Effect.sync(() => state.getWebSockets(tag).map(fromWebSocket)),
  setWebSocketAutoResponse: (maybeReqResp?: cf.WebSocketRequestResponsePair) =>
    Effect.sync(() => state.setWebSocketAutoResponse(maybeReqResp)),
  getWebSocketAutoResponse: () =>
    Effect.sync(() => state.getWebSocketAutoResponse()),
  getWebSocketAutoResponseTimestamp: (ws: cf.WebSocket) =>
    Effect.sync(() => state.getWebSocketAutoResponseTimestamp(ws)),
  setHibernatableWebSocketEventTimeout: (timeoutMs?: number) =>
    Effect.sync(() => state.setHibernatableWebSocketEventTimeout(timeoutMs)),
  getHibernatableWebSocketEventTimeout: () =>
    Effect.sync(() => state.getHibernatableWebSocketEventTimeout()),
  getTags: (ws: cf.WebSocket) => Effect.sync(() => state.getTags(ws)),
  abort: (reason?: string) => Effect.sync(() => state.abort(reason)),
});

// ---------------------------------------------------------------------------
// The instance shape and the export record a host publishes per class
// ---------------------------------------------------------------------------

export interface DurableObjectShape {
  fetch?: HttpEffect<DurableObjectState | RuntimeContext>;
  alarm?: (
    alarmInfo?: AlarmInvocationInfo,
  ) => Effect.Effect<void, never, never>;
  webSocketMessage?: (
    socket: WebSocket,
    message: string | ArrayBuffer,
  ) => Effect.Effect<void>;
  webSocketClose?: (
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ) => Effect.Effect<void>;
}

export interface DurableObjectExport {
  readonly kind: "durableObject";
  readonly constructor: Effect.Effect<
    Effect.Effect<DurableObjectShape, never, RuntimeContext>,
    never,
    DurableObjectState
  >;
  readonly services: Context.Context<never>;
}

export const isDurableObjectExport = (
  value: unknown,
): value is DurableObjectExport =>
  typeof value === "object" && (value as any)?.kind === "durableObject";

// ---------------------------------------------------------------------------
// Hosting: the seam between a class declaration and the worker hosting it
// ---------------------------------------------------------------------------

/** A Durable Object class declaration as registered on its hosting worker. */
export interface DurableObjectBindingDeclaration {
  /** Binding name — the Durable Object's logical id. */
  readonly name: string;
  /** The exported class name backing the binding. */
  readonly className: string;
  /** Foreign hosting script, for cross-script bindings. */
  readonly scriptName?: Input<string> | undefined;
  /** Normalized former-host identifiers driving a transfer migration. */
  readonly transferredFrom?: Input<string>[] | undefined;
}

/**
 * The least a native namespace stub must offer the engine's stub flavor:
 * an HTTP entry (workerd and celld stubs are fetchers). An engine whose
 * runtime environment hands back finished stubs (Rivet) satisfies it
 * trivially.
 */
export interface DurableObjectStubLike {
  readonly fetch?: (
    input: string | URL | globalThis.Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

/** The native namespace binding found under the class name in the runtime environment. */
export interface DurableObjectNamespaceLike {
  getByName(name: string, options?: unknown): DurableObjectStubLike;
}

/**
 * The shape of a resource that can HOST Durable Objects: any native worker
 * resource (Cloudflare / Celld / Rivet) — a `Platform()`-built instance
 * whose runtime context exposes `export` alongside the resource's `bind`.
 * Non-worker hosts (Lambda Functions, ECS tasks) have `bind` but no
 * `export`, which is what routes them to the remote-caller path.
 *
 * The two flavor members are the per-engine variation points, assigned by
 * an engine's `createRuntimeContext`.
 */
export interface DurableObjectHostLike {
  readonly LogicalId: string;
  readonly bind: (
    template: TemplateStringsArray,
    ...args: any[]
  ) => (data: any) => Effect.Effect<void>;
  readonly export: (name: string, value: any) => Effect.Effect<void>;
  /**
   * Host-native binding data for a Durable Object class declaration —
   * what `host.bind` receives when a hosted DO layer registers itself
   * (Cloudflare: `{ bindings: [{ type: "durable_object_namespace", … }] }`;
   * Celld / Rivet: `{ durableObjects: [{ name, className }] }`).
   */
  readonly durableObjectBinding: (
    decl: DurableObjectBindingDeclaration,
  ) => unknown;
  /**
   * The engine's stub flavor over an instance stub selected from the
   * runtime environment's native namespace binding (workerd wraps the
   * JSRPC stub, celld wraps with the fetch-RPC transport, Rivet's synthetic
   * env already returns finished stubs).
   */
  readonly durableObjectStub: (
    nativeStub: DurableObjectStubLike,
    namespace: string,
  ) => unknown;
}

export const isDurableObjectHost = (
  value: unknown,
): value is DurableObjectHostLike =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  // `in` first: a resource proxy answers property READS for any attribute
  // name with a callable `PropExpr` Output accessor, so `typeof
  // host.export === "function"` alone is true for EVERY resource (a
  // Lambda included). `in` forwards to the proxy target and only reports
  // properties that really exist (`export` and the flavors are
  // Object.assigned onto worker instances by their runtime context; refs
  // report nothing).
  "bind" in (value as object) &&
  "export" in (value as object) &&
  "durableObjectBinding" in (value as object) &&
  "durableObjectStub" in (value as object) &&
  typeof (value as { bind?: unknown }).bind === "function" &&
  typeof (value as { export?: unknown }).export === "function";

/**
 * The Durable Object hosting core — ONE implementation of "register the
 * class on its hosting worker and export it". Binding registration,
 * runtime-env namespace resolution, the plan-time mock-state evaluation
 * that discovers transitive bindings, and the class export are
 * engine-invariant; the binding data shape and the stub flavor come from
 * the host.
 */
export const makeDurableObjectHosting = (namespace: string) => {
  const register = (
    host: DurableObjectHostLike,
    decl: Omit<DurableObjectBindingDeclaration, "name">,
  ) =>
    Effect.gen(function* () {
      const declaration: DurableObjectBindingDeclaration = {
        name: namespace,
        ...decl,
      };
      // Binding data is HOST-NATIVE: the host's runtime context shapes the
      // declaration for its platform's worker binding contract.
      yield* host.bind`${namespace}`(host.durableObjectBinding(declaration));

      const native = yield* Effect.all([
        Effect.serviceOption(WorkerEnvironment).pipe(
          Effect.map(Option.getOrUndefined),
        ),
        ALCHEMY_PHASE,
      ]).pipe(
        Effect.flatMap(
          ([env, phase]): Effect.Effect<
            DurableObjectNamespaceLike | undefined
          > => {
            if (env === undefined || phase === "plan") {
              // only undefined at plan time — nothing to call yet
              return Effect.succeed(undefined);
            }
            const ns: unknown = env[namespace];
            if (!ns) {
              return Effect.die(
                new Error(
                  `DurableObject '${namespace}' not found in the worker environment`,
                ),
              );
            }
            if (
              typeof ns !== "object" ||
              !("getByName" in ns) ||
              typeof ns.getByName !== "function"
            ) {
              return Effect.die(
                new Error(
                  `DurableObject '${namespace}' is not a DurableObject`,
                ),
              );
            }
            return Effect.succeed(ns as DurableObjectNamespaceLike);
          },
        ),
      );

      const stub = (nativeStub: DurableObjectStubLike) =>
        host.durableObjectStub(nativeStub, namespace);
      return { native, stub } as const;
    });

  const exportClass = (
    host: DurableObjectHostLike,
    constructor: Effect.Effect<
      Effect.Effect<DurableObjectShape, never, any>,
      never,
      DurableObjectState
    >,
  ) =>
    Effect.gen(function* () {
      const phase = yield* ALCHEMY_PHASE;
      if (phase === "plan") {
        // Evaluate the init phase with a mock state at plan time so
        // transitive bindings the object depends on are discovered and
        // registered on the worker.
        yield* constructor.pipe(
          Effect.provide(
            Layer.succeed(
              DurableObjectState,
              fromDurableObjectState({ storage: {} } as any),
            ),
          ),
        );
      }
      // `export` lives on the runtime context assigned onto the instance —
      // present at both plan and runtime, but not part of the resource type.
      yield* host.export(namespace, {
        kind: "durableObject",
        // initialize the object's constructor (apply infra dependencies)
        constructor,
        // grab the object's infra dependencies so we can apply them when
        // calling the instance's methods
        services: yield* Effect.context<never>(),
      } satisfies DurableObjectExport);
    });

  return { register, exportClass };
};

/** Resolve the ambient hosting worker, whatever its engine. */
export const requireDurableObjectHost = (namespace: string) =>
  Effect.flatMap(Binding.Host, (host) =>
    isDurableObjectHost(host)
      ? Effect.succeed(host)
      : Effect.die(
          new Error(
            `DurableObject '${namespace}' must be declared inside a Worker — ` +
              "provide its layer on a hosting worker's impl.",
          ),
        ),
  );
