import type * as cf from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { HttpServerError } from "effect/unstable/http/HttpServerError";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { HttpEffect } from "../../Http.ts";
import * as Output from "../../Output.ts";
import type { PlatformServices } from "../../Platform.ts";
import { effectClass, taggedFunction } from "../../Util/effect.ts";
import {
  DurableObjectState,
  fromDurableObjectState,
} from "./DurableObjectState.ts";
import { makeRpcStub } from "./Rpc.ts";
import { type DurableWebSocket } from "./WebSocket.ts";
import { Worker, WorkerEnvironment, type WorkerServices } from "./Worker.ts";

export interface DurableObjectExport {
  readonly kind: "durableObject";
  readonly make: (
    state: cf.DurableObjectState,
    env: any,
  ) => Effect.Effect<Record<string, unknown>>;
}

export const isDurableObjectExport = (
  value: unknown,
): value is DurableObjectExport =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  (value as any).kind === "durableObject";

export type DurableObjectId = cf.DurableObjectId;
export type DurableObjectJurisdiction = cf.DurableObjectJurisdiction;
export type DurableObjectNamespaceGetDurableObjectOptions =
  cf.DurableObjectNamespaceGetDurableObjectOptions;

export type AlarmInvocationInfo = cf.AlarmInvocationInfo;

type TypeId = "Cloudflare.DurableObjectNamespace";
const TypeId = "Cloudflare.DurableObjectNamespace";

export const isDurableObjectNamespaceLike = (
  value: unknown,
): value is DurableObjectNamespaceLike =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  value.kind === TypeId;

export interface DurableObjectNamespaceLike<Shape = any> {
  kind: TypeId;
  name: string;
  /** @internal phantom */
  className?: string;
  /** @internal phantom */
  Shape?: Shape;
}

export interface DurableObjectNamespace<
  Shape = unknown,
> extends DurableObjectNamespaceLike<Shape> {
  Type: TypeId;
  name: string;
  namespaceId: Output.Output<string>;
  getByName: (name: string) => DurableObjectStub<Shape>;
  newUniqueId: () => DurableObjectId;
  idFromName: (name: string) => DurableObjectId;
  idFromString: (id: string) => DurableObjectId;
  get: (
    id: DurableObjectId,
    options?: DurableObjectNamespaceGetDurableObjectOptions,
  ) => DurableObjectStub<Shape>;
  jurisdiction: (
    jurisdiction: DurableObjectJurisdiction,
  ) => DurableObjectNamespace<Shape>;
}

export interface DurableObjectShape {
  fetch?: HttpEffect<DurableObjectState>;
  alarm?: (
    alarmInfo?: AlarmInvocationInfo,
  ) => Effect.Effect<void, never, never>;
  webSocketMessage?: (
    socket: DurableWebSocket,
    message: string | ArrayBuffer,
  ) => Effect.Effect<void>;
  webSocketClose?: (
    socket: DurableWebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ) => Effect.Effect<void>;
}

export type DurableObjectServices =
  | DurableObjectNamespace
  | DurableObjectState
  | WorkerServices
  | WorkerEnvironment
  | PlatformServices;

export interface DurableObjectNamespaceProps {
  /**
   * @default name
   */
  className: string;
  // scriptName?: string | undefined;
  // environment?: string | undefined;
  // sqlite?: boolean | undefined;
  // namespaceId?: string | undefined;
}

export interface DurableObjectNamespaceClass extends Effect.Effect<
  DurableObjectNamespace,
  never,
  DurableObjectNamespace
> {
  <Self>(): {
    <Shape, InitReq = never>(
      name: string,
      impl: Effect.Effect<
        Effect.Effect<Shape, never, DurableObjectServices>,
        never,
        InitReq
      >,
    ): Effect.Effect<
      DurableObjectNamespace<Self>,
      never,
      Worker | Exclude<InitReq, DurableObjectServices>
    > & {
      new (_: never): Shape;
    };
  };
  <Shape>(
    name: string,
    props?: DurableObjectNamespaceProps,
  ): DurableObjectNamespaceLike<Shape>;
  <Shape, InitReq = never>(
    name: string,
    impl: Effect.Effect<
      Effect.Effect<Shape, never, DurableObjectServices>,
      never,
      InitReq
    >,
  ): Effect.Effect<
    DurableObjectNamespace<Shape>,
    never,
    Worker | Exclude<InitReq, DurableObjectServices>
  >;
}

export class DurableObjectNamespaceScope extends Context.Service<
  DurableObjectNamespaceScope,
  DurableObjectNamespace
>()("Cloudflare.DurableObjectNamespace") {}

/**
 * A Cloudflare Durable Object namespace that manages globally unique, stateful
 * instances with WebSocket hibernation support.
 *
 * A Durable Object uses a two-phase pattern with two nested `Effect.gen`
 * blocks. The outer Effect resolves shared dependencies (other DOs,
 * containers, etc.). The inner Effect runs once per instance and returns
 * the object's public methods and WebSocket handlers.
 *
 * ```typescript
 * Effect.gen(function* () {
 *   // Phase 1: resolve shared dependencies
 *   const db = yield* Cloudflare.D1Connection.bind(MyDB);
 *
 *   return Effect.gen(function* () {
 *     // Phase 2: per-instance setup and public API
 *     const state = yield* Cloudflare.DurableObjectState;
 *
 *     return {
 *       save: (data: string) => db.exec("INSERT ..."),
 *       fetch: Effect.gen(function* () { ... }),
 *       webSocketMessage: Effect.fnUntraced(function* (ws, msg) { ... }),
 *     };
 *   });
 * })
 * ```
 *
 * There are two ways to define a Durable Object. See the
 * {@link https://alchemy.run/concepts/platform | Platform concept} page
 * for the full explanation.
 *
 * - **Inline** — Effect implementation passed directly, single file.
 * - **Modular** — class and implementation in separate files for tree-shaking.
 *
 * @resource
 *
 * @section Inline Durable Objects
 * Pass the Effect implementation as the second argument. This is the
 * simplest approach — everything lives in one file. Convenient when
 * the DO doesn't need to be referenced by other Workers or DOs that
 * would pull in its runtime dependencies.
 *
 * @example Inline Durable Object
 * ```typescript
 * export default class Counter extends Cloudflare.DurableObjectNamespace<Counter>()(
 *   "Counter",
 *   Effect.gen(function* () {
 *     // init: bind resources
 *     const db = yield* Cloudflare.D1Connection.bind(MyDB);
 *
 *     return Effect.gen(function* () {
 *       const state = yield* Cloudflare.DurableObjectState;
 *       const count = (yield* state.storage.get<number>("count")) ?? 0;
 *
 *       return {
 *         // runtime: use them
 *         increment: () =>
 *           Effect.gen(function* () {
 *             const next = count + 1;
 *             yield* state.storage.put("count", next);
 *             return next;
 *           }),
 *         get: () => Effect.succeed(count),
 *       };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * @section Modular Durable Objects
 * When a Worker and a DO reference each other, or multiple Workers
 * bind the same DO, define the class separately from its `.make()`
 * call. The class is a lightweight identifier; `.make()` provides
 * the runtime implementation as an `export default`. Rolldown treats
 * `.make()` as pure, so the bundler tree-shakes it and all its
 * runtime dependencies out of any consumer's bundle.
 *
 * The class and `.make()` can live in the same file. This is the
 * same pattern used by `Worker` and `Container`.
 *
 * @example Modular Durable Object (class + .make() in one file)
 * ```typescript
 * // src/Counter.ts
 * export default class Counter extends Cloudflare.DurableObjectNamespace<Counter>()(
 *   "Counter",
 * ) {}
 *
 * export default Counter.make(
 *   Effect.gen(function* () {
 *     // init: bind resources
 *     const db = yield* Cloudflare.D1Connection.bind(MyDB);
 *
 *     return Effect.gen(function* () {
 *       const state = yield* Cloudflare.DurableObjectState;
 *       const count = (yield* state.storage.get<number>("count")) ?? 0;
 *
 *       return {
 *         // runtime: use them
 *         increment: () =>
 *           Effect.gen(function* () {
 *             const next = count + 1;
 *             yield* state.storage.put("count", next);
 *             yield* db.prepare("INSERT INTO logs (count) VALUES (?)").bind(next).run();
 *             return next;
 *           }),
 *         get: () => Effect.succeed(count),
 *       };
 *     });
 *   }),
 * );
 * ```
 *
 * @example Binding a modular DO from a Worker
 * ```typescript
 * // imports Counter; bundler tree-shakes .make()
 * import Counter from "./Counter.ts";
 *
 * // init
 * const counters = yield* Counter;
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const counter = counters.getByName("user-123");
 *     return HttpServerResponse.text(String(yield* counter.get()));
 *   }),
 * };
 * ```
 *
 * @section RPC Methods
 * Any function you return from the inner Effect becomes an RPC method
 * that Workers can call through a stub. Methods must return an `Effect`.
 * The caller gets a fully typed stub — if your DO returns `increment`
 * and `get`, the stub exposes `counter.increment()` and `counter.get()`.
 *
 * @example Defining RPC methods
 * ```typescript
 * return {
 *   increment: () => Effect.succeed(++count),
 *   get: () => Effect.succeed(count),
 *   reset: () => Effect.sync(() => { count = 0; }),
 * };
 * ```
 *
 * @section Returning Streams from RPC
 * RPC methods can return an Effect `Stream` and the caller will see
 * the chunks as they're produced. Combine with `Stream.schedule` to
 * pace emission, or with `Stream.fromQueue` to bridge an inbound
 * subscription.
 *
 * @example Streaming sequential numbers
 * ```typescript
 * import * as Schedule from "effect/Schedule";
 * import * as Stream from "effect/Stream";
 *
 * return {
 *   tick: (n: number) =>
 *     Stream.iterate(0, (i) => i + 1).pipe(
 *       Stream.take(n),
 *       Stream.schedule(Schedule.spaced("100 millis")),
 *     ),
 * };
 * ```
 *
 * @example Forwarding the stream as a chunked HTTP response
 * ```typescript
 * // in a Worker fetch handler
 * const counter = counters.getByName("tick");
 * const stream = counter.tick(5).pipe(
 *   Stream.map((i) => `${i}\n`),
 *   Stream.encodeText,
 * );
 * return HttpServerResponse.stream(stream, {
 *   headers: { "content-type": "text/plain" },
 * });
 * ```
 *
 * @section Worker → DO HTTP forwarding
 * In addition to RPC methods, the typed stub exposes a `fetch`
 * method that forwards an `HttpServerRequest` straight to the DO.
 * The DO's own `fetch` Effect produces the response — useful for
 * WebSocket upgrades and other request-shaped interactions.
 *
 * @example Forwarding an HTTP request to a DO
 * ```typescript
 * const room = rooms.getByName(roomId);
 * return yield* room.fetch(request);
 * ```
 *
 * @section Accessing Instance State
 * Each Durable Object instance has its own transactional key-value
 * storage via `Cloudflare.DurableObjectState`. Use `storage.get` and
 * `storage.put` inside the inner Effect to persist data across requests
 * and restarts.
 *
 * @example Reading and writing durable storage
 * ```typescript
 * const state = yield* Cloudflare.DurableObjectState;
 *
 * yield* state.storage.put("counter", 42);
 * const value = yield* state.storage.get("counter");
 * ```
 *
 * @section WebSocket Hibernation
 * Durable Objects support WebSocket hibernation — the runtime can
 * evict the object from memory while keeping connections open. Use
 * `Cloudflare.upgrade()` to accept a connection, and return
 * `webSocketMessage` / `webSocketClose` handlers to process events
 * when the object wakes back up.
 *
 * @example Accepting a WebSocket connection
 * ```typescript
 * return {
 *   fetch: Effect.gen(function* () {
 *     const [response, socket] = yield* Cloudflare.upgrade();
 *     socket.serializeAttachment({ id: crypto.randomUUID() });
 *     return response;
 *   }),
 * };
 * ```
 *
 * @example Handling messages and close events
 * ```typescript
 * return {
 *   webSocketMessage: Effect.fnUntraced(function* (
 *     socket: Cloudflare.DurableWebSocket,
 *     message: string | Uint8Array,
 *   ) {
 *     const text = typeof message === "string"
 *       ? message
 *       : new TextDecoder().decode(message);
 *     // process the message
 *   }),
 *   webSocketClose: Effect.fnUntraced(function* (
 *     ws: Cloudflare.DurableWebSocket,
 *     code: number,
 *     reason: string,
 *   ) {
 *     yield* ws.close(code, reason);
 *   }),
 * };
 * ```
 *
 * @example Recovering sessions after hibernation
 * Place the rehydration loop **inside the inner `Effect.gen`** so
 * it runs every time the DO instance is reconstructed (including
 * after Cloudflare wakes the DO from hibernation).
 *
 * ```typescript
 * return Effect.gen(function* () {
 *   const state = yield* Cloudflare.DurableObjectState;
 *   const sessions = new Map<string, Cloudflare.DurableWebSocket>();
 *
 *   // Rehydrate the in-memory session map after hibernation.
 *   for (const socket of yield* state.getWebSockets()) {
 *     const data = socket.deserializeAttachment<{ id: string }>();
 *     if (data) sessions.set(data.id, socket);
 *   }
 *
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const [response, socket] = yield* Cloudflare.upgrade();
 *       const id = crypto.randomUUID();
 *       socket.serializeAttachment({ id });
 *       sessions.set(id, socket);
 *       return response;
 *     }),
 *     webSocketMessage: Effect.fnUntraced(function* (socket, message) {
 *       const text =
 *         typeof message === "string" ? message : new TextDecoder().decode(message);
 *       for (const peer of sessions.values()) {
 *         yield* peer.send(text);
 *       }
 *     }),
 *   };
 * });
 * ```
 *
 * @section Scheduled Alarms
 * Each Durable Object can have a single alarm timestamp. Alchemy
 * layers a small SQLite-backed scheduler on top via
 * `Cloudflare.scheduleEvent` and `Cloudflare.processScheduledEvents`,
 * so you can register many named events with arbitrary payloads and
 * fire them from a single `alarm` handler.
 *
 * @example Scheduling and processing events
 * ```typescript
 * // schedule from a request or message handler
 * yield* Cloudflare.scheduleEvent(
 *   "reminder-1",
 *   new Date(Date.now() + 60_000),
 *   { message: "your meeting starts in a minute" },
 * );
 *
 * return {
 *   alarm: () =>
 *     Effect.gen(function* () {
 *       const fired = yield* Cloudflare.processScheduledEvents;
 *       for (const event of fired) {
 *         const payload = event.payload as { message: string };
 *         // dispatch / broadcast / persist...
 *       }
 *     }),
 * };
 * ```
 *
 * @section Using from a Worker
 * Yield the DO class in your Worker's init phase to get a namespace
 * handle. Call `getByName` or `getById` to get a typed stub, then
 * call any RPC method or forward an HTTP request with `fetch`.
 *
 * @example Calling RPC methods
 * ```typescript
 * // init
 * const counters = yield* Counter;
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const counter = counters.getByName("user-123");
 *     yield* counter.increment();
 *     const value = yield* counter.get();
 *     return HttpServerResponse.text(String(value));
 *   }),
 * };
 * ```
 *
 * @example Forwarding an HTTP request
 * ```typescript
 * // init
 * const rooms = yield* Room;
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const request = yield* HttpServerRequest;
 *     const room = rooms.getByName(roomId);
 *     return yield* room.fetch(request);
 *   }),
 * };
 * ```
 *
 * @section Binding in an Async Worker
 * When using an Async Worker (plain `async fetch` handler, no Effect
 * runtime), declare Durable Objects in the `bindings` prop of the
 * Worker resource. Pass a `DurableObjectNamespace` reference with a
 * `className` matching the exported `DurableObject` subclass in your
 * worker source file. Use `Cloudflare.InferEnv` to get a fully typed
 * `env` object that includes the namespace.
 *
 * @example Declaring a DO binding in the stack
 * ```typescript
 * // alchemy.run.ts
 * import type { Counter } from "./src/worker.ts";
 *
 * export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;
 *
 * export const Worker = Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   bindings: {
 *     Counter: Cloudflare.DurableObjectNamespace<Counter>("Counter", {
 *       className: "Counter",
 *     }),
 *   },
 * });
 * ```
 *
 * @example Using the DO from a plain async handler
 * ```typescript
 * // src/worker.ts
 * import { DurableObject } from "cloudflare:workers";
 * import type { WorkerEnv } from "../alchemy.run.ts";
 *
 * export default {
 *   async fetch(request: Request, env: WorkerEnv) {
 *     const counter = env.Counter.getByName("my-counter");
 *     const count = await counter.increment();
 *     return new Response(JSON.stringify({ count }));
 *   },
 * };
 *
 * export class Counter extends DurableObject {
 *   private counter = 0;
 *   async increment() {
 *     return ++this.counter;
 *   }
 * }
 * ```
 */
export const DurableObjectNamespace: DurableObjectNamespaceClass =
  taggedFunction(DurableObjectNamespaceScope, ((
    ...args:
      | []
      | [name: string, props?: DurableObjectNamespaceProps]
      | [
          name: string,
          impl: Effect.Effect<
            Effect.Effect<
              DurableObjectNamespace<any>,
              never,
              DurableObjectState
            >
          >,
        ]
  ) =>
    args.length === 0
      ? DurableObjectNamespace
      : !Effect.isEffect(args[1])
        ? ({
            kind: TypeId,
            name: args[0],
            className: (args[1] as DurableObjectNamespaceProps | undefined)
              ?.className,
          } satisfies DurableObjectNamespaceLike<any>)
        : effectClass(
            Effect.gen(function* () {
              const [namespace, impl] = args as any as [
                name: string,
                impl: Effect.Effect<
                  Effect.Effect<
                    DurableObjectNamespace<any>,
                    never,
                    DurableObjectState
                  >
                >,
              ];
              const worker = yield* Worker;

              yield* worker.bind`${namespace}`({
                // TODO(sam): automate class migrations, probably in the provider
                bindings: [
                  {
                    type: "durable_object_namespace",
                    name: namespace,
                    className: namespace,
                    // scriptName:
                    //   binding.scriptName === props.workerName
                    //     ? undefined
                    //     : binding.scriptName,
                    // environment: binding.environment,
                    // namespaceId: binding.namespaceId,
                  },
                ],
              });

              const services =
                yield* Effect.context<Effect.Services<typeof impl>>();

              yield* worker.export(namespace, {
                kind: "durableObject",
                make: (state: cf.DurableObjectState, env: any) => {
                  const doState = fromDurableObjectState(state);
                  return constructor.pipe(
                    Effect.provideContext(services),
                    Effect.provideService(DurableObjectState, doState),
                    Effect.provideService(WorkerEnvironment, env),
                    Effect.map((methods: any) => {
                      const wrapped: Record<string, unknown> = {};
                      for (const key of Object.getOwnPropertyNames(methods)) {
                        const value = methods[key];
                        if (Effect.isEffect(value)) {
                          wrapped[key] = (
                            value as Effect.Effect<any, any, any>
                          ).pipe(
                            Effect.provideService(DurableObjectState, doState),
                          );
                        } else if (typeof value === "function") {
                          wrapped[key] = (...args: unknown[]) => {
                            const result = (value as Function)(...args);
                            if (Effect.isEffect(result)) {
                              return (
                                result as Effect.Effect<any, any, any>
                              ).pipe(
                                Effect.provideService(
                                  DurableObjectState,
                                  doState,
                                ),
                              );
                            }
                            return result;
                          };
                        } else {
                          wrapped[key] = value;
                        }
                      }
                      return wrapped;
                    }),
                  );
                },
              } satisfies DurableObjectExport);

              const binding = yield* Effect.serviceOption(
                WorkerEnvironment,
              ).pipe(
                Effect.map(Option.getOrUndefined),
                Effect.flatMap((env) => {
                  if (env === undefined) {
                    // should be fine to return undefined here (it is only undefined at plantime)
                    return Effect.succeed(undefined);
                  }
                  const ns = env[namespace];
                  if (!ns) {
                    return Effect.die(
                      new Error(
                        `DurableObjectNamespace '${namespace}' not found`,
                      ),
                    );
                  } else if (typeof ns.getByName === "function") {
                    return Effect.succeed(ns);
                  } else {
                    return Effect.die(
                      new Error(
                        `DurableObjectNamespace '${namespace}' is not a DurableObjectNamespace`,
                      ),
                    );
                  }
                }),
              );

              const namespaceId = worker.durableObjectNamespaces.pipe(
                Output.map(
                  (durableObjectNamespaces) =>
                    durableObjectNamespaces?.[namespace],
                ),
              );

              const self = {
                Type: TypeId,
                LogicalId: namespace,
                name: namespace,
                namespaceId,
                getByName: (name: string) =>
                  makeRpcStub(binding.getByName(name)),
                // newUniqueId: () => use((ns) => ns.newUniqueId()),
                // idFromName: (name: string) => use((ns) => ns.idFromName(name)),
                // idFromString: (id: string) => use((ns) => ns.idFromString(id)),
                // get: (
                //   id: cf.DurableObjectId,
                //   options?: cf.DurableObjectNamespaceGetDurableObjectOptions,
                // ) => use((ns) => makeRpcStub(ns.get(id, options))),
                // jurisdiction: (jurisdiction: cf.DurableObjectJurisdiction) =>
                //   use((ns) => ns.jurisdiction(jurisdiction) as any),
              };

              const constructor = yield* impl.pipe(
                Effect.provideService(DurableObjectNamespaceScope, self as any),
              );

              return self;
            }),
          )) as any);

export type DurableObjectStub<Shape> = {
  // TODO(sam): do we need to transform? hopefully not
  [key in keyof Shape]: Shape[key];
} & {
  fetch: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpServerError,
    never
  >;
};
