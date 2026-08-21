import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { makeProcessScope, runOnHost } from "../Local/Process.ts";
import type { Actor } from "./Agent.ts";
import { Driver, type Charter, type Interpretable } from "./Driver.ts";
import {
  makeSessionEngine,
  reminderInput,
  stoppedByOperator,
  type SessionEngine,
} from "./DriverCore.ts";
import * as Option from "effect/Option";
import { SessionIndex, sessionId } from "./SessionIndex.ts";
import {
  handleSessionSocketFrame,
  type SessionSocketClientFrame,
  type SessionSocketServerFrame,
} from "./SessionSocket.ts";
import { Sessions } from "./Sessions.ts";
import { ThreadStorage } from "./ThreadStorage.ts";

type SendFrame = (frame: SessionSocketServerFrame) => Effect.Effect<void>;

/**
 * The RESIDENT Driver — `AI.Driver` for anything process-shaped (a
 * dev machine, a server): each session is a forked fiber that bursts,
 * then parks on a wake signal until the world moves. The ALGORITHM
 * and the LIFECYCLE live in {@link makeSessionEngine} (`DriverCore`);
 * this Layer contributes only what a process physically owns:
 *
 * - **kick** — offer to the session's wake queue (starting its fiber
 *   on first sight);
 * - **broadcast** — a RAM set of socket writers per session, served
 *   over the host's own HTTP server (`Sessions.attach`);
 * - **remind / recovery re-entry** — sleeping fibers on the process
 *   scope;
 * - **restore** — persisted sessions revive parked at interpret,
 *   their fibers started when the Host program runs.
 *
 * Substrate is the `ThreadStorage` Layer: `ThreadStorageMemory` for
 * ephemeral sessions, `ThreadStorageSqlite` for a durable local
 * process — with the durable inbox and the round liveness marker,
 * a killed process redelivers pre-crash inputs and recovers
 * interrupted rounds exactly as Durable Objects do.
 *
 * ```ts
 * AI.DriverLocal.pipe(Layer.provide(AI.ThreadStorageMemory))
 * AI.DriverLocal.pipe(Layer.provide(ThreadStorageSqlite(".alchemy/runs.sqlite")))
 * ```
 */
export const DriverLocal: Layer.Layer<
  Driver | Sessions,
  never,
  LanguageModel.LanguageModel | ThreadStorage
> = Layer.unwrap(
  Effect.gen(function* () {
    const languageModel = yield* LanguageModel.LanguageModel;
    const threadStorage = yield* ThreadStorage;
    // `Sessions.list` delegates to whatever index the assembly
    // composed in; absent an index, the population is unlistable
    const sessionIndex = yield* Effect.serviceOption(SessionIndex);
    // Process-lifetime forks (session fibers, reminders, sockets):
    // under a Platform Host these survive `Effect.provide` of the org
    // layer; in unit tests they ride the ambient Scope wrapping the
    // test body.
    const process = yield* makeProcessScope;

    /** term → its engine (the socket gateway resolves through this). */
    const engines = new Map<string, SessionEngine>();
    /** term → key → attached socket writers (the broadcast seam). */
    const sockets = new Map<string, Map<string, Set<SendFrame>>>();
    /** term → drop one key's RESIDENT state (fiber-start marker, wake
     *  queue) so a removed key can be admitted fresh — registered by
     *  each interpret over its own closures. */
    const residents = new Map<string, (key: string) => void>();

    const socketsOf = (term: string, key: string): Set<SendFrame> => {
      let byKey = sockets.get(term);
      if (byKey === undefined) {
        byKey = new Map();
        sockets.set(term, byKey);
      }
      let set = byKey.get(key);
      if (set === undefined) {
        set = new Set();
        byKey.set(key, set);
      }
      return set;
    };

    const interpret = (term: Interpretable, charter: Charter) =>
      Effect.gen(function* () {
        const context = yield* Effect.context<never>();
        const termName = term["~alchemy/Name"];

        // ── the resident machinery: one fiber + one wake queue per
        // session ─────────────────────────────────────────────────
        const wakes = new Map<string, Queue.Queue<void>>();
        const wakeOf = (key: string): Effect.Effect<Queue.Queue<void>> =>
          Effect.gen(function* () {
            let wake = wakes.get(key);
            if (wake === undefined) {
              wake = yield* Queue.unbounded<void>();
              wakes.set(key, wake);
            }
            return wake;
          });

        const started = new Set<string>();
        /**
         * The resident loop: burst until parked, then wait for a wake
         * or the session's settlement. The engine serializes bursts
         * internally, so redundant wakes just park again.
         */
        const fiberLoop = (key: string) =>
          Effect.gen(function* () {
            const wake = yield* wakeOf(key);
            while (true) {
              yield* engine.burst(key);
              const settled = yield* Effect.raceFirst(
                Effect.map(Queue.take(wake), () => false as const),
                Effect.map(engine.awaitSettled(key), () => true as const),
              );
              if (settled) break;
            }
          });
        const startFiber = (key: string): Effect.Effect<void> =>
          Effect.suspend(() => {
            if (started.has(key)) return Effect.void;
            started.add(key);
            return Effect.asVoid(process.fork(fiberLoop(key)));
          });

        const engine: SessionEngine = makeSessionEngine({
          driver: "DriverLocal",
          term: termName,
          charter,
          context,
          storage: threadStorage,
          languageModel,
          kick: (key) =>
            Effect.gen(function* () {
              yield* startFiber(key);
              yield* Queue.offer(yield* wakeOf(key), undefined as void);
            }),
          broadcast: (key, frame) =>
            Effect.forEach(
              [...socketsOf(termName, key)],
              (send) => Effect.ignore(send(frame)),
              { discard: true },
            ),
          // the CLOCK: a sleeping fiber on the process scope, exactly
          // as durable as the session on this placement. Delivery is
          // an ordinary send — a wake if parked, queued if busy,
          // dropped if settled.
          remind: (key, fireAtMillis, note) =>
            Effect.asVoid(
              process.fork(
                Effect.sleep(
                  Duration.millis(Math.max(0, fireAtMillis - Date.now())),
                ).pipe(
                  Effect.andThen(engine.send(reminderInput(note), { key })),
                  Effect.asVoid,
                ),
              ),
            ),
          // recovery re-entry: a forked sleep — a stale re-entry
          // finds nothing owed and parks instantly
          scheduleReentry: (key, delayMillis) =>
            Effect.asVoid(
              process.fork(
                Effect.sleep(Duration.millis(delayMillis)).pipe(
                  Effect.andThen(engine.burst(key)),
                  Effect.asVoid,
                ),
              ),
            ),
        });
        engines.set(termName, engine);
        residents.set(termName, (key) => {
          started.delete(key);
          wakes.delete(key);
        });

        // ── RESTORE (bootstrap §3): persisted sessions come back
        // PARKED, threads primed, seq cursor continued. Their fibers
        // start when the Host program runs — a plan-time build
        // registers-and-discards, so it can never hang on the Host.
        const revived = yield* engine.restore;
        for (const key of revived) {
          yield* runOnHost(startFiber(key)).pipe(
            Effect.asVoid,
          ) as Effect.Effect<void>;
        }

        return {
          send: (item, options) => engine.send(item, options),
          // a waiter failed with the session's typed crash surfaces
          // at the Actor boundary as a defect — same as the RPC
          // placement's `orDie` (spec §11b: the crash was already
          // DELIVERED via the `crashed` observation)
          dispatch: (item, options) =>
            Effect.orDie(engine.dispatch(item, options)),
          steer: ((first: unknown, second?: unknown) =>
            second === undefined
              ? engine.steer(undefined, first)
              : engine.steer(first as string, second)) as Actor["steer"],
          settle: (sessionKey, event) => engine.settle(sessionKey, event),
          interrupt: () => engine.interrupt,
        } satisfies Actor;
      });

    /**
     * The local {@link Sessions.attach}: the SAME protocol the Durable
     * Object placement speaks, served in-process — a WebSocket
     * upgrade on the host's own HTTP server, replay from the
     * session's handle, live broadcast from the engine's observe.
     */
    // socket-serving fibers live on the process Scope — never on the
    // HTTP request that carried the upgrade: Bun counts an unresolved
    // upgraded request as in-flight, and the server's graceful stop
    // would wait its whole 20s budget on it
    const attach = (
      term: string,
      key: string,
      request: HttpServerRequest.HttpServerRequest,
    ): Effect.Effect<HttpServerResponse.HttpServerResponse, never, never> =>
      Effect.gen(function* () {
        const engine = engines.get(term);
        if (engine === undefined) {
          return yield* Effect.die(
            `DriverLocal: no interpreted term '${term}' to attach to — has its Layer been built?`,
          );
        }
        // observing a session must not feed it
        const host = yield* engine.socketHost(key);
        const socket = yield* request.upgrade.pipe(Effect.orDie);
        const serve = Effect.gen(function* () {
          const write = yield* socket.writer;
          const send: SendFrame = (frame) =>
            Effect.asVoid(
              Effect.ignore(write(JSON.stringify(frame))),
            ) as Effect.Effect<void>;
          const handle = handleSessionSocketFrame(host, send);
          const registry = socketsOf(term, key);
          registry.add(send);
          yield* socket
            .runString((raw: string) =>
              handle(JSON.parse(raw) as SessionSocketClientFrame).pipe(
                Effect.catchDefect((defect) =>
                  Effect.logWarning(`[session-socket] bad frame: ${defect}`),
                ),
              ),
            )
            .pipe(
              Effect.ignore,
              Effect.ensuring(Effect.sync(() => registry.delete(send))),
            );
        });
        yield* process.fork(Effect.scoped(serve).pipe(Effect.asVoid));
        return HttpServerResponse.empty();
      });

    // the operator's off switch: settle in place (children cascade,
    // the fiber loop's settled race ends it) — a term this process
    // never interpreted has nothing to stop
    const stop = (term: string, key: string): Effect.Effect<void> => {
      const engine = engines.get(term);
      return engine === undefined
        ? Effect.void
        : engine.settle(key, stoppedByOperator, { admit: true });
    };

    return Layer.mergeAll(
      Layer.succeed(Driver, { interpret }),
      Layer.succeed(Sessions, {
        attach,
        list: () =>
          Option.match(sessionIndex, {
            onNone: () => Effect.succeed([]),
            onSome: (index) => index.list(),
          }),
        stop,
        remove: (term, key) =>
          Effect.gen(function* () {
            yield* stop(term, key);
            // forget the RAM shell + resident machinery so the key
            // can be admitted fresh, then purge the durable rows
            yield* engines.get(term)?.forget(key) ?? Effect.void;
            residents.get(term)?.(key);
            sockets.get(term)?.delete(key);
            yield* threadStorage.remove(term, key);
            yield* Option.match(sessionIndex, {
              onNone: () => Effect.void,
              onSome: (index) => index.remove(sessionId(term, key)),
            });
          }),
      }),
    );
  }),
);
