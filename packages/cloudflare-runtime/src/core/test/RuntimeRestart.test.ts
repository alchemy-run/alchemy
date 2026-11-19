import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { assert, expect, layer } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import * as DurableObjectNamespace from "../bindings/DurableObjectNamespace.ts";
import * as Service from "../bindings/Service.ts";
import * as Runtime from "../Runtime.ts";
import { SystemError } from "../RuntimeError.shared.ts";
import { WorkerdEvent } from "../RuntimeWorker.ts";
import * as Workerd from "../workerd/Workerd.ts";
import { fetchOverSocket, localRuntimeLayer, makeLocalRuntimeLayer } from "./helpers/runtime.ts";

/** A {@link WorkerdEvent} with an exit reduced to the fields a test can predict. */
type ObservedEvent =
  | Exclude<WorkerdEvent, { readonly type: "workerd.process.exited" }>
  | { readonly type: "workerd.process.exited"; readonly pid: number };

const WorkerdEventJson = Schema.toCodecJson(WorkerdEvent);

/** Sends each event through JSON text and back, as a host logging them would. */
const roundTrip = (events: ReadonlyArray<WorkerdEvent>) =>
  events.map((event) =>
    Schema.decodeUnknownSync(WorkerdEventJson)(
      JSON.parse(JSON.stringify(Schema.encodeSync(WorkerdEventJson)(event))),
    ),
  );

/**
 * Records every lifecycle event of a worker, and lets a test wait for the
 * next one it cares about.
 */
const recordEvents = Effect.gen(function* () {
  const events: Array<WorkerdEvent> = [];
  const pending = yield* Queue.unbounded<WorkerdEvent>();
  const onEvent = (event: WorkerdEvent) => {
    events.push(event);
    Queue.offerUnsafe(pending, event);
  };
  /** Waits for the next event that matches, skipping the ones before it. */
  const next = <E extends WorkerdEvent>(match: (event: WorkerdEvent) => event is E) =>
    Queue.take(pending).pipe(
      Effect.repeat({ until: match }),
      Effect.map((event) => event as E),
      Effect.timeout(10_000),
    );
  return {
    onEvent,
    events,
    /** Waits for the next replacement to serve, returning its generation. */
    restarted: next(
      (event): event is Extract<WorkerdEvent, { type: "workerd.process.started" }> =>
        event.type === "workerd.process.started" && event.generation > 0,
    ).pipe(Effect.map((event) => event.generation)),
    /** Waits for recovery to give up. */
    stopped: next(
      (event): event is Extract<WorkerdEvent, { type: "workerd.recovery.stopped" }> =>
        event.type === "workerd.recovery.stopped",
    ),
    /** Waits for the next replacement to be scheduled. */
    scheduled: next(
      (event): event is Extract<WorkerdEvent, { type: "workerd.restart.scheduled" }> =>
        event.type === "workerd.restart.scheduled",
    ),
    exits: () =>
      events.flatMap((event) => (event.type === "workerd.process.exited" ? [event.exit] : [])),
    pids: () =>
      events.flatMap((event) => (event.type === "workerd.process.started" ? [event.pid] : [])),
    observed: () =>
      events.map((event): ObservedEvent =>
        event.type === "workerd.process.exited"
          ? { type: "workerd.process.exited", pid: event.exit.pid }
          : event,
      ),
  };
});

/**
 * `/crash` exhausts the isolate's heap. With a small `--max-old-space-size`
 * V8 aborts the process the way it does in a long dev session, only faster.
 */
const CRASHING_SCRIPT = `
const hog = [];
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/crash") {
      for (;;) hog.push(new Array(1_000_000).fill(url.pathname));
    }
    return env.SERVICE ? env.SERVICE.fetch(request) : new Response("hello");
  },
};
`;

const CRASHING_DURABLE_OBJECT_SCRIPT = `
import { DurableObject } from "cloudflare:workers";
const hog = [];
export class Pinger extends DurableObject {
  fetch(request) {
    if (request.headers.get("Upgrade") === "websocket") {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      server.addEventListener("message", (event) => server.send(event.data));
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("fetch ok");
  }
  ping() {
    return "rpc ok";
  }
}
export default {
  fetch(request) {
    if (new URL(request.url).pathname === "/crash") {
      for (;;) hog.push(new Array(1_000_000).fill("crash"));
    }
    return new Response("hello");
  },
};
`;

const DURABLE_OBJECT_CONSUMER_SCRIPT = `
export default {
  async fetch(request, env) {
    const stub = env.PINGER.get(env.PINGER.idFromName("singleton"));
    try {
      if (new URL(request.url).pathname === "/rpc") {
        return new Response(await stub.ping());
      }
      return await stub.fetch(request);
    } catch (error) {
      return new Response(String(error));
    }
  },
};
`;

const fetchText = (url: URL) =>
  Effect.tryPromise(async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return await response.text();
  });

const openSocket = (url: URL) =>
  Effect.acquireRelease(
    Effect.callback<WebSocket, Error>((resume) => {
      const socket = new WebSocket(new URL(url.pathname, url.href.replace(/^http/, "ws")));
      socket.once("open", () => resume(Effect.succeed(socket)));
      socket.once("error", (error) => resume(Effect.fail(error)));
    }).pipe(Effect.timeout(10_000)),
    (socket) => Effect.sync(() => socket.terminate()),
  );

const echo = (socket: WebSocket, message: string) =>
  Effect.callback<string>((resume) => {
    socket.once("message", (data) => resume(Effect.succeed(String(data))));
    socket.send(message);
  }).pipe(Effect.timeout(5_000));

const closed = (socket: WebSocket) =>
  Effect.callback<void>((resume) => {
    if (socket.readyState === WebSocket.CLOSED) {
      return resume(Effect.void);
    }
    socket.once("close", () => resume(Effect.void));
  }).pipe(Effect.timeout(10_000));

layer(localRuntimeLayer, { excludeTestServices: true })("Runtime restart", (it) => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  it.effect(
    "releases each process generation and bounds repeated crash recovery",
    () =>
      Effect.gen(function* () {
        vi.stubEnv(Workerd.V8_FLAGS_ENV, "--max-old-space-size=32");
        const runtime = yield* Runtime.Runtime;
        const workerd = yield* Workerd.Workerd;
        const serve = workerd.serve;
        let active = 0;
        let started = 0;
        vi.spyOn(workerd, "serve").mockImplementation((...args) =>
          Effect.gen(function* () {
            expect(active).toBe(0);
            const ports = yield* serve(...args);
            active++;
            started++;
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                active--;
              }),
            );
            return ports;
          }),
        );
        const recorder = yield* recordEvents;
        const url = yield* runtime.start({
          name: "restarting",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          bindings: [],
          modules: [{ name: "main.js", type: "ESModule", content: CRASHING_SCRIPT }],
          onEvent: recorder.onEvent,
        });
        expect(yield* fetchText(new URL("/hello", url))).toBe("hello");

        for (let crash = 1; crash <= 3; crash++) {
          yield* fetchText(new URL("/crash", url)).pipe(Effect.ignore);
          const answer = yield* fetchText(new URL("/hello", url)).pipe(
            Effect.retry({
              schedule: Schedule.spaced("250 millis"),
              times: 10,
            }),
          );
          expect(answer).toBe("hello");
          // The replacement can serve HTTP before its Started event arrives.
          expect(yield* recorder.restarted).toBe(crash);
          expect(recorder.exits()).toHaveLength(crash);
          expect(recorder.exits()[crash - 1].stderr).toContain("JavaScript heap out of memory");
          expect(active).toBe(1);
        }
        // The fourth crash exhausts the rolling restart budget.
        yield* fetchText(new URL("/crash", url)).pipe(Effect.ignore);
        yield* recorder.stopped;
        expect(started).toBe(4);
        expect(active).toBe(0);
        // Each generation is its own process, and each exit reports the
        // process that served before it.
        const [first, second, third, fourth] = recorder.pids();
        expect(new Set([first, second, third, fourth]).size).toBe(4);
        expect(recorder.observed()).toEqual<Array<ObservedEvent>>([
          { type: "workerd.process.started", pid: first, generation: 0 },
          { type: "workerd.process.exited", pid: first },
          { type: "workerd.restart.scheduled", attempt: 1, delayMs: 250 },
          { type: "workerd.process.started", pid: second, generation: 1 },
          { type: "workerd.process.exited", pid: second },
          { type: "workerd.restart.scheduled", attempt: 2, delayMs: 500 },
          { type: "workerd.process.started", pid: third, generation: 2 },
          { type: "workerd.process.exited", pid: third },
          { type: "workerd.restart.scheduled", attempt: 3, delayMs: 1_000 },
          { type: "workerd.process.started", pid: fourth, generation: 3 },
          { type: "workerd.process.exited", pid: fourth },
          { type: "workerd.recovery.stopped", reason: "restart-limit" },
        ]);
        expect(roundTrip(recorder.events)).toEqual(recorder.events);
        expect(yield* fetchText(new URL("/hello", url)).pipe(Effect.exit)).toMatchObject({
          _tag: "Failure",
        });
      }),
    { timeout: 60_000 },
  );

  it.effect.skipIf(process.platform === "win32")(
    "a replacement process serves on the same Unix socket",
    () => {
      const socketPath = NodePath.join(NodeOs.tmpdir(), `alchemy-restart-test-${process.pid}.sock`);
      return Effect.gen(function* () {
        vi.stubEnv(Workerd.V8_FLAGS_ENV, "--max-old-space-size=32");
        const runtime = yield* Runtime.Runtime;
        const recorder = yield* recordEvents;
        const url = yield* runtime.start({
          name: "restarting-unix-socket",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          bindings: [],
          modules: [{ name: "main.js", type: "ESModule", content: CRASHING_SCRIPT }],
          onEvent: recorder.onEvent,
          entrySocketPath: socketPath,
        });
        expect(yield* fetchOverSocket(socketPath, "/hello")).toBe("hello");
        yield* fetchText(new URL("/crash", url)).pipe(Effect.ignore);
        expect(yield* recorder.restarted).toBe(1);
        // workerd leaves the crashed process's socket file behind; the
        // replacement binds the same path once it is removed.
        expect(yield* fetchOverSocket(socketPath, "/hello")).toBe("hello");
      }).pipe(Effect.ensuring(Effect.sync(() => NodeFs.rmSync(socketPath, { force: true }))));
    },
    { timeout: 60_000 },
  );

  it.effect(
    "restores current service targets and keeps receiving registry updates",
    () =>
      Effect.gen(function* () {
        vi.stubEnv(Workerd.V8_FLAGS_ENV, "--max-old-space-size=32");
        const runtime = yield* Runtime.Runtime;
        const parent = yield* Effect.scope;
        let providerScope = yield* Scope.fork(parent);
        const startProvider = (version: string) =>
          runtime
            .start({
              name: "restart-dependency",
              compatibilityDate: "2026-03-10",
              compatibilityFlags: [],
              bindings: [],
              modules: [
                {
                  name: "main.js",
                  type: "ESModule",
                  content: `export default { fetch: () => new Response("${version}") };`,
                },
              ],
            })
            .pipe(Scope.provide(providerScope));
        yield* startProvider("one");
        const url = yield* runtime.start({
          name: "restart-consumer",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          bindings: [
            Service.local({
              binding: "SERVICE",
              scriptName: "restart-dependency",
            }),
          ],
          modules: [
            {
              name: "main.js",
              type: "ESModule",
              content: CRASHING_SCRIPT,
            },
          ],
        });
        const expectVersion = (version: string) =>
          fetchText(url).pipe(
            Effect.filterOrFail(
              (text) => text === version,
              () => new Error("stale service target"),
            ),
            Effect.retry({
              schedule: Schedule.spaced("250 millis"),
              times: 10,
            }),
            Effect.tap((text) => Effect.sync(() => expect(text).toBe(version))),
          );
        yield* expectVersion("one");
        yield* Scope.close(providerScope, Exit.void);
        providerScope = yield* Scope.fork(parent);
        yield* startProvider("two");
        yield* expectVersion("two");

        yield* fetchText(new URL("/crash", url)).pipe(Effect.ignore);
        yield* expectVersion("two");

        yield* Scope.close(providerScope, Exit.void);
        providerScope = yield* Scope.fork(parent);
        yield* startProvider("three");
        yield* expectVersion("three");
      }),
    { timeout: 60_000 },
  );

  it.effect(
    "stops recovery and reports why when a replacement fails to start",
    () =>
      Effect.gen(function* () {
        vi.stubEnv(Workerd.V8_FLAGS_ENV, "--max-old-space-size=32");
        const runtime = yield* Runtime.Runtime;
        const workerd = yield* Workerd.Workerd;
        const serve = workerd.serve;
        const failure = SystemError.make({
          subtag: "WorkerdStart",
          message: "replacement refused to start",
          // Not JSON: an `undefined` field and an `Error`, as real details carry.
          detail: { address: undefined, error: new Error("bind failed") },
        });
        let calls = 0;
        vi.spyOn(workerd, "serve").mockImplementation((...args) =>
          ++calls === 1 ? serve(...args) : Effect.fail(failure),
        );
        const recorder = yield* recordEvents;
        const url = yield* runtime.start({
          name: "failing-replacement",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          bindings: [],
          modules: [{ name: "main.js", type: "ESModule", content: CRASHING_SCRIPT }],
          onEvent: recorder.onEvent,
        });
        expect(yield* fetchText(new URL("/hello", url))).toBe("hello");
        yield* fetchText(new URL("/crash", url)).pipe(Effect.ignore);
        yield* recorder.stopped;

        const [pid] = recorder.pids();
        expect(calls).toBe(2);
        expect(recorder.observed()).toEqual<Array<ObservedEvent>>([
          { type: "workerd.process.started", pid, generation: 0 },
          { type: "workerd.process.exited", pid },
          { type: "workerd.restart.scheduled", attempt: 1, delayMs: 250 },
          { type: "workerd.recovery.stopped", reason: "restart-failed", error: failure },
        ]);
        // The failure survives JSON as the same typed error. Its detail is
        // reduced to JSON: the undefined field drops, the Error keeps its
        // name and message.
        const decoded = roundTrip(recorder.events);
        expect(decoded.slice(0, -1)).toEqual(recorder.events.slice(0, -1));
        const stopped = decoded.at(-1);
        assert(stopped?.type === "workerd.recovery.stopped");
        assert(stopped.error instanceof SystemError);
        expect(stopped.reason).toBe("restart-failed");
        expect(stopped.error.subtag).toBe("WorkerdStart");
        expect(stopped.error.message).toBe("replacement refused to start");
        expect(stopped.error.detail).toEqual({ error: { name: "Error", message: "bind failed" } });
      }),
    { timeout: 30_000 },
  );

  const startClosing = (recorder: Effect.Success<typeof recordEvents>) =>
    Effect.gen(function* () {
      const runtime = yield* Runtime.Runtime;
      const url = yield* runtime.start({
        name: "closing",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        bindings: [],
        modules: [{ name: "main.js", type: "ESModule", content: CRASHING_SCRIPT }],
        onEvent: recorder.onEvent,
      });
      expect(yield* fetchText(new URL("/hello", url))).toBe("hello");
      return url;
    });

  it.effect(
    "reports no exit when the runtime closes",
    () =>
      Effect.gen(function* () {
        const recorder = yield* recordEvents;
        yield* startClosing(recorder).pipe(Effect.scoped);
        // Give a wrongly reported exit time to arrive.
        yield* Effect.sleep(1_000);
        const [pid] = recorder.pids();
        expect(recorder.observed()).toEqual<Array<ObservedEvent>>([
          { type: "workerd.process.started", pid, generation: 0 },
        ]);
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "closing the runtime during the restart backoff cancels the replacement",
    () =>
      Effect.gen(function* () {
        vi.stubEnv(Workerd.V8_FLAGS_ENV, "--max-old-space-size=32");
        const workerd = yield* Workerd.Workerd;
        const serve = vi.spyOn(workerd, "serve");
        const recorder = yield* recordEvents;
        yield* Effect.gen(function* () {
          const url = yield* startClosing(recorder);
          yield* fetchText(new URL("/crash", url)).pipe(Effect.ignore);
          // The replacement is pending: close inside its 250ms backoff.
          yield* recorder.scheduled;
        }).pipe(Effect.scoped);
        // Give a wrongly started replacement time to report.
        yield* Effect.sleep(1_000);
        expect(serve).toHaveBeenCalledTimes(1);
        const [pid] = recorder.pids();
        expect(recorder.observed()).toEqual<Array<ObservedEvent>>([
          { type: "workerd.process.started", pid, generation: 0 },
          { type: "workerd.process.exited", pid },
          { type: "workerd.restart.scheduled", attempt: 1, delayMs: 250 },
        ]);
      }),
    { timeout: 30_000 },
  );

  it.effect(
    "closing the runtime while a replacement starts reports no failed restart",
    () =>
      Effect.gen(function* () {
        vi.stubEnv(Workerd.V8_FLAGS_ENV, "--max-old-space-size=32");
        const workerd = yield* Workerd.Workerd;
        const serve = workerd.serve;
        const replacing = yield* Deferred.make<void>();
        const killed = SystemError.make({
          subtag: "WorkerdStart",
          message: "killed while starting",
        });
        let calls = 0;
        // The replacement is still starting when the runtime closes. Like a
        // real workerd killed mid-start, it fails once its scope closes.
        vi.spyOn(workerd, "serve").mockImplementation((...args) =>
          ++calls === 1
            ? serve(...args)
            : Effect.gen(function* () {
                const closed = yield* Deferred.make<void>();
                yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
                yield* Deferred.succeed(replacing, undefined);
                yield* Deferred.await(closed);
                return yield* Effect.fail(killed);
              }),
        );
        const recorder = yield* recordEvents;
        yield* Effect.gen(function* () {
          const url = yield* startClosing(recorder);
          yield* fetchText(new URL("/crash", url)).pipe(Effect.ignore);
          yield* Deferred.await(replacing).pipe(Effect.timeout(10_000));
        }).pipe(Effect.scoped);
        // Give a wrongly reported failure time to arrive.
        yield* Effect.sleep(500);
        expect(calls).toBe(2);
        const [pid] = recorder.pids();
        expect(recorder.observed()).toEqual<Array<ObservedEvent>>([
          { type: "workerd.process.started", pid, generation: 0 },
          { type: "workerd.process.exited", pid },
          { type: "workerd.restart.scheduled", attempt: 1, delayMs: 250 },
        ]);
      }),
    { timeout: 30_000 },
  );

  // Events are side effects: recovery neither stops for a failing callback
  // nor waits for a pending one, and a failure is logged as a warning per
  // event. Vitest fails the run on an unhandled rejection, so the rejecting
  // case also proves it is caught.
  const callbacks = {
    throws: {
      callback: (event: WorkerdEvent) => {
        throw new Error(`host failed on ${event.type}`);
      },
      warns: true,
    },
    rejects: {
      callback: (event: WorkerdEvent) => Promise.reject(new Error(`host failed on ${event.type}`)),
      warns: true,
    },
    "never settles": { callback: () => new Promise<void>(() => {}), warns: false },
  };
  for (const [behavior, { callback, warns }] of Object.entries(callbacks)) {
    it.effect(
      `keeps recovering when the onEvent callback ${behavior}`,
      () =>
        Effect.gen(function* () {
          vi.stubEnv(Workerd.V8_FLAGS_ENV, "--max-old-space-size=32");
          const runtime = yield* Runtime.Runtime;
          const recorder = yield* recordEvents;
          const warnings: Array<string> = [];
          const captureWarnings = Logger.make<unknown, void>(({ logLevel, message }) => {
            const [text] = Array.isArray(message) ? message : [message];
            if (logLevel === "Warn" && typeof text === "string" && text.includes("onEvent")) {
              warnings.push(text);
            }
          });
          const url = yield* runtime
            .start({
              name: "failing-callback",
              compatibilityDate: "2026-03-10",
              compatibilityFlags: [],
              bindings: [],
              modules: [{ name: "main.js", type: "ESModule", content: CRASHING_SCRIPT }],
              onEvent: (event) => {
                recorder.onEvent(event);
                return callback(event);
              },
            })
            .pipe(Effect.provide(Logger.layer([captureWarnings], { mergeWithExisting: true })));
          yield* fetchText(new URL("/crash", url)).pipe(Effect.ignore);
          expect(yield* recorder.restarted).toBe(1);
          expect(yield* fetchText(new URL("/hello", url))).toBe("hello");
          expect(recorder.events.map((event) => event.type)).toEqual<Array<WorkerdEvent["type"]>>([
            "workerd.process.started",
            "workerd.process.exited",
            "workerd.restart.scheduled",
            "workerd.process.started",
          ]);
          // A rejection is logged once it settles, after the event itself.
          yield* Effect.sync(() => warnings.length).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("50 millis"),
              until: (count) => !warns || count === 4,
              times: 20,
            }),
          );
          expect(warnings).toEqual(
            warns
              ? recorder.events.map(
                  (event) => `The onEvent callback for "failing-callback" failed on ${event.type}.`,
                )
              : [],
          );
        }),
      { timeout: 30_000 },
    );
  }
});

// Replacement processes reach Durable Object proxies through registry updates,
// which Windows delivers by polling rather than watching.
const watcherModes = process.platform === "win32" ? [false] : [true, false];

for (const fileSystemSupportsWatcher of watcherModes) {
  layer(makeLocalRuntimeLayer({ fileSystemSupportsWatcher }), { excludeTestServices: true })(
    `Runtime restart across scripts (fileSystemSupportsWatcher: ${fileSystemSupportsWatcher})`,
    (it) => {
      afterEach(() => vi.unstubAllEnvs());
      it.effect(
        "reconnects a cross-script Durable Object to its owner's replacement process",
        () =>
          Effect.gen(function* () {
            vi.stubEnv(Workerd.V8_FLAGS_ENV, "--max-old-space-size=32");
            const runtime = yield* Runtime.Runtime;
            const recorder = yield* recordEvents;
            const owner = yield* runtime.start({
              name: "restart-durable-object-owner",
              compatibilityDate: "2026-03-10",
              compatibilityFlags: [],
              bindings: [],
              modules: [
                { name: "main.js", type: "ESModule", content: CRASHING_DURABLE_OBJECT_SCRIPT },
              ],
              durableObjectNamespaces: [
                { className: "Pinger", sql: false, uniqueKey: "restart-durable-object" },
              ],
              onEvent: recorder.onEvent,
            });
            const consumer = yield* runtime.start({
              name: "restart-durable-object-consumer",
              compatibilityDate: "2026-03-10",
              compatibilityFlags: [],
              bindings: [
                DurableObjectNamespace.local({
                  binding: "PINGER",
                  className: "Pinger",
                  scriptName: "restart-durable-object-owner",
                  uniqueKey: "restart-durable-object",
                }),
              ],
              modules: [
                { name: "main.js", type: "ESModule", content: DURABLE_OBJECT_CONSUMER_SCRIPT },
              ],
            });
            // Calls arrive well inside the proxy's idle eviction window, so a stale
            // connection would fail every attempt.
            const expectAnswer = (path: string, answer: string) =>
              fetchText(new URL(path, consumer)).pipe(
                Effect.filterOrFail(
                  (text) => text === answer,
                  (text) => new Error(text),
                ),
                Effect.retry({
                  schedule: Schedule.spaced("250 millis"),
                  times: 10,
                }),
                Effect.tap((text) => Effect.sync(() => expect(text).toBe(answer))),
              );
            yield* expectAnswer("/rpc", "rpc ok");
            yield* expectAnswer("/fetch", "fetch ok");

            // The replacement listens on the same debug port.
            yield* fetchText(new URL("/crash", owner)).pipe(Effect.ignore);
            yield* recorder.restarted;
            yield* expectAnswer("/rpc", "rpc ok");
            yield* expectAnswer("/fetch", "fetch ok");
          }),
        { timeout: 60_000 },
      );

      it.effect(
        "keeps a cross-script Durable Object WebSocket open across calls and reconnects after a restart",
        () =>
          Effect.gen(function* () {
            vi.stubEnv(Workerd.V8_FLAGS_ENV, "--max-old-space-size=32");
            const runtime = yield* Runtime.Runtime;
            const recorder = yield* recordEvents;
            const owner = yield* runtime.start({
              name: "restart-websocket-owner",
              compatibilityDate: "2026-03-10",
              compatibilityFlags: [],
              bindings: [],
              modules: [
                { name: "main.js", type: "ESModule", content: CRASHING_DURABLE_OBJECT_SCRIPT },
              ],
              durableObjectNamespaces: [
                { className: "Pinger", sql: false, uniqueKey: "restart-websocket" },
              ],
              onEvent: recorder.onEvent,
            });
            const consumer = yield* runtime.start({
              name: "restart-websocket-consumer",
              compatibilityDate: "2026-03-10",
              compatibilityFlags: [],
              bindings: [
                DurableObjectNamespace.local({
                  binding: "PINGER",
                  className: "Pinger",
                  scriptName: "restart-websocket-owner",
                  uniqueKey: "restart-websocket",
                }),
              ],
              modules: [
                { name: "main.js", type: "ESModule", content: DURABLE_OBJECT_CONSUMER_SCRIPT },
              ],
            });

            const socket = yield* openSocket(new URL("/ws", consumer)).pipe(
              Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 10 }),
            );
            expect(yield* echo(socket, "before")).toBe("before");
            // Other calls through the proxy share the Durable Object without
            // disturbing the open socket.
            for (let i = 0; i < 20; i++) {
              expect(yield* fetchText(new URL("/rpc", consumer))).toBe("rpc ok");
            }
            expect(yield* echo(socket, "between")).toBe("between");

            // The owner's crash ends the socket; a new one reaches the replacement.
            yield* fetchText(new URL("/crash", owner)).pipe(Effect.ignore);
            yield* closed(socket);
            yield* recorder.restarted;
            const replacement = yield* openSocket(new URL("/ws", consumer)).pipe(
              Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 10 }),
            );
            expect(yield* echo(replacement, "after")).toBe("after");
          }).pipe(Effect.scoped),
        { timeout: 60_000 },
      );
    },
  );
}
