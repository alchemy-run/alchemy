/**
 * The node side of a pool: host each `Rivet.DurableObject` class the node
 * was built with as a RivetKit actor.
 *
 * RivetKit is imported lazily: it loads a native addon.
 *
 * @internal
 */
import type { DurableObjectExport } from "alchemy/Workers/DurableObject";
import {
  makeDurableObjectInstance,
  type DurableObjectInstance,
} from "alchemy/Workers/DurableObjectBridge";
import { EventLifetime } from "alchemy/Workers/EventLifetime";
import type { WorkerBuild } from "alchemy/Workers/Worker";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { HostedDurableObject } from "../DurableObject.ts";
import {
  ALARM_ACTION,
  DurableObjectState,
  makeDurableObjectState,
  migrateStorage,
  runFiredAlarm,
  type ActorContextLike,
} from "../DurableObjectState.ts";
import type { WebSocket } from "../WebSocket.ts";
import {
  AWAITING_HEADER,
  Awaiting,
  DEADLOCK_STATUS,
  isDeadlock,
  makeActivation,
  receive,
  waitingSection,
  type Activation,
} from "./Calls.ts";
import {
  makeSocketRegistry,
  PendingWebSocket,
  type RawWebSocket,
  type SocketRegistry,
} from "./Sockets.ts";

/** What an actor activation keeps in memory until it sleeps. */
interface ActivationVars {
  instance: DurableObjectInstance | undefined;
  activation: Activation | undefined;
  sockets: SocketRegistry | undefined;
}

type ActivationContext = ActorContextLike & {
  readonly vars: ActivationVars;
  /** The request a WebSocket was opened with. */
  readonly request?: Request | undefined;
};

/** Read a RivetKit setting the pool put in the node's environment. */
const env = (name: string): string | undefined => process.env[name];

const deadlock = (message: string) => new Response(message, { status: DEADLOCK_STATUS });

/** Serve one actor request through the instance's `fetch` (and fetch-RPC). */
const handleRequest = (
  instance: DurableObjectInstance,
  activation: Activation,
  request: Request,
) => {
  const awaiting = receive(request.headers.get(AWAITING_HEADER));
  // The instance's construction waits on this call, and the call can't
  // start until construction finishes.
  if (waitingSection(activation, awaiting.received) === activation.construction) {
    return Promise.resolve(
      deadlock(
        "This Durable Object's constructor waits on this call, which can't run until construction finishes.",
      ),
    );
  }
  return instance.execute(
    (shape) =>
      Effect.gen(function* () {
        let response = yield* instance
          .fetch(shape, request)
          .pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(request),
            ),
          );
        // A streamed body is read after the call returns: it runs with the
        // call's context, and the call stays open until it settles.
        const context = yield* Effect.context<never>();
        const lifetime = yield* Effect.serviceOption(EventLifetime);
        if (response.body._tag === "Stream" && Option.isSome(lifetime)) {
          let done!: () => void;
          lifetime.value.extend(new Promise<void>((resolve) => (done = resolve)));
          response = HttpServerResponse.setBody(
            response,
            HttpBody.stream(
              Stream.ensuring(response.body.stream, Effect.sync(done)),
              response.body.contentType,
              response.body.contentLength,
            ),
          );
        }
        return HttpServerResponse.toWeb(response, { context });
      }).pipe(Effect.provideService(Awaiting, awaiting)),
    async (exit) =>
      Exit.isSuccess(exit)
        ? (exit.value as Response)
        : isDeadlock(exit.cause)
          ? deadlock(
              "A transaction on this Durable Object waits on this call, which needs its storage.",
            )
          : new Response("Internal Server Error", { status: 500 }),
  );
};

/** The path a WebSocket's request reaches `fetch` with: the caller's, without the gateway's prefix. */
const withoutGatewayPrefix = (request: Request) => {
  const url = new URL(request.url, "http://actor");
  if (url.pathname !== "/websocket" && !url.pathname.startsWith("/websocket/")) return request;
  url.pathname = url.pathname.slice("/websocket".length) || "/";
  return new Request(url, request);
};

/**
 * Serve a WebSocket through the instance's `fetch`, which accepts it with
 * `Rivet.upgrade()`; then deliver its events to the instance's
 * `webSocketMessage`, `webSocketClose` and `webSocketError`, one at a time.
 * A `fetch` that doesn't accept it closes it.
 */
const handleWebSocket = async (
  instance: DurableObjectInstance,
  activation: Activation,
  sockets: SocketRegistry,
  request: Request | undefined,
  ws: RawWebSocket,
) => {
  ws.binaryType = "arraybuffer";
  let socket: WebSocket | undefined;
  // Events run in order, after `fetch` accepted the socket.
  let events: Promise<unknown> = Promise.resolve();
  const deliver = (
    handler: "webSocketMessage" | "webSocketClose" | "webSocketError",
    ...args: ReadonlyArray<unknown>
  ) => {
    events = events.then(() =>
      socket === undefined
        ? undefined
        : instance
            .execute((shape) => {
              const run = shape[handler] as
                | ((...args: ReadonlyArray<unknown>) => Effect.Effect<void>)
                | undefined;
              return run === undefined
                ? Effect.void
                : Effect.suspend(() => run(socket, ...args)).pipe(
                    Effect.provideService(Awaiting, receive(undefined)),
                    Effect.catchCause((cause) =>
                      Effect.logError(`Durable Object ${handler} failed`, cause),
                    ),
                  );
            })
            .catch(() => undefined),
    );
  };
  ws.addEventListener("message", (event: { data: unknown }) =>
    deliver(
      "webSocketMessage",
      typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer),
    ),
  );
  ws.addEventListener("close", (event: { code: number; reason: string; wasClean: boolean }) => {
    if (socket !== undefined) sockets.remove(socket);
    deliver("webSocketClose", event.code, event.reason, event.wasClean);
  });
  ws.addEventListener("error", (event: { error?: unknown }) =>
    deliver("webSocketError", event.error ?? event),
  );
  if (request === undefined) return ws.close(1011, "No upgrade request");
  const upgrade = withoutGatewayPrefix(request);
  const awaiting = receive(upgrade.headers.get(AWAITING_HEADER));
  if (waitingSection(activation, awaiting.received) === activation.construction) {
    return ws.close(1011, "This Durable Object's constructor waits on this call.");
  }
  const status = await instance.execute(
    (shape) =>
      instance.fetch(shape, upgrade).pipe(
        Effect.map((response) => response.status),
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(upgrade),
        ),
        Effect.provideService(PendingWebSocket, {
          accept: (tags) =>
            Effect.sync(() => {
              socket ??= sockets.add(ws, tags);
              return socket;
            }),
        }),
        Effect.provideService(Awaiting, awaiting),
      ),
    async (exit) => (Exit.isSuccess(exit) ? (exit.value as number) : 500),
  );
  // Not accepted: the caller sees the status as the close reason.
  if (socket === undefined) ws.close(status >= 500 ? 1011 : 1008, `HTTP ${status}`);
};

/**
 * Host every Durable Object class as a RivetKit actor and connect this node
 * to the control plane. Runs for the life of the node.
 */
export const runDurableObjects = (durableObjects: ReadonlyArray<HostedDurableObject>) =>
  Effect.gen(function* () {
    if (durableObjects.length === 0) return yield* Effect.never;
    const { actor, setup } = yield* Effect.promise(() => import("rivetkit"));
    const { db } = yield* Effect.promise(() => import("rivetkit/db"));

    const use: Record<string, unknown> = {};
    for (const hosted of durableObjects) {
      const name = hosted.name;
      const build: WorkerBuild<DurableObjectExport, unknown> = {
        // The services the class phase ran with.
        context: hosted.context as Context.Context<any>,
        runtimeContext: hosted.runtime,
        // The class phase has already run: its result is the instance constructor.
        export: {
          kind: "durableObject",
          constructor: Effect.succeed(hosted.instance),
          services: hosted.context,
        },
        shape: () => ({}),
        telemetry: () => undefined,
      };
      // One instance per actor activation, built on its first call. RivetKit
      // hands every request its own context object, so the instance lives
      // in the activation's vars, which last until the actor sleeps.
      const instanceOf = (c: ActivationContext) => {
        let instance = c.vars.instance;
        if (instance === undefined) {
          const activation = makeActivation();
          const sockets = makeSocketRegistry();
          c.vars.activation = activation;
          c.vars.sockets = sockets;
          instance = makeDurableObjectInstance({
            build: () => Promise.resolve(build),
            // RivetKit runs an actor's calls concurrently over async
            // storage; a class given `Workers.InputGate` gets a gate per
            // instance from the bridge.
            services: Context.make(
              DurableObjectState,
              makeDurableObjectState(c, activation, sockets),
            ).pipe(
              // Construction runs under the activation's construction
              // section; each call replaces it with what it was sent.
              Context.add(Awaiting, {
                received: [],
                own: [
                  {
                    token: activation.construction,
                    open: () => activation.open.has(activation.construction),
                  },
                ],
              }),
            ),
            waitUntil: (promise) => c.waitUntil(promise),
            // RPC arrives as fetch-RPC over the actor's `fetch`.
            dispatch: "static",
          });
          c.vars.instance = instance;
        }
        const activation = c.vars.activation!;
        // Construction has finished once a call starts, or fails.
        const constructed = () => void activation.open.delete(activation.construction);
        const execute: DurableObjectInstance["execute"] = (fn, onExit) =>
          instance
            .execute((shape) => {
              constructed();
              return fn(shape);
            }, onExit)
            .finally(constructed);
        return { instance: { ...instance, execute }, activation, sockets: c.vars.sockets! };
      };

      use[name] = actor({
        db: db({ onMigrate: (database) => migrateStorage(database) }),
        createVars: (): ActivationVars => ({
          instance: undefined,
          activation: undefined,
          sockets: undefined,
        }),
        onRequest: (c: ActivationContext, request: Request) => {
          const { instance, activation } = instanceOf(c);
          return handleRequest(instance, activation, request);
        },
        // A WebSocket through the gateway: the instance's `fetch` accepts it
        // with `Rivet.upgrade()`.
        onWebSocket: (c: ActivationContext, ws: RawWebSocket) => {
          const { instance, activation, sockets } = instanceOf(c);
          return handleWebSocket(instance, activation, sockets, c.request, ws);
        },
        actions: {
          // RivetKit times an action out after 60 seconds, and an alarm can
          // wait out a transaction before its handler runs as long as it
          // takes: the action only starts it, kept awake until it's done.
          [ALARM_ACTION]: (c: ActivationContext, token: unknown) => {
            void c.keepAwake(
              instanceOf(c).instance.execute((shape) =>
                runFiredAlarm(
                  c,
                  token,
                  typeof shape.alarm === "function"
                    ? Effect.suspend(() => (shape.alarm as () => Effect.Effect<void>)())
                    : undefined,
                ).pipe(
                  Effect.provideService(Awaiting, receive(undefined)),
                  Effect.catchCause((cause) =>
                    Effect.logError("Durable Object alarm could not run", cause),
                  ),
                ),
              ),
            );
          },
        },
      } as never);
    }

    const registry = setup({
      use,
      endpoint: env("RIVET_ENDPOINT"),
      token: env("RIVET_TOKEN"),
      namespace: env("RIVET_NAMESPACE"),
      envoy: { poolName: env("RIVET_POOL") },
      noWelcome: true,
    } as never) as { startAndWait(): Promise<void>; shutdown(): Promise<void> };

    yield* Effect.promise(() => registry.startAndWait());
    yield* Effect.logInfo(
      `Rivet node connected: ${durableObjects.map((hosted) => hosted.name).join(", ")}`,
    );
    return yield* Effect.never.pipe(Effect.ensuring(Effect.promise(() => registry.shutdown())));
  });
