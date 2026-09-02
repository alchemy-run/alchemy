/**
 * The DURABLE OBJECT placement of the session engine — `AI.Driver`
 * for Cloudflare: ONE DO instance per session (named
 * `${term}/${key}`), verbs as RPC, the thread and inbox in DO
 * storage, reminders and crash recovery on the DO alarm, live views
 * on hibernatable WebSockets.
 *
 * The ALGORITHM and the LIFECYCLE are not here: both live in
 * {@link makeSessionEngine} (`DriverCore`) — the same code
 * `AI.DriverLocal` runs on a laptop. This module contributes only
 * what the substrate physically owns:
 *
 * - **storage** — {@link makeThreadStorageDurableObject}: the shared
 *   `ThreadHandle` contract over the instance's own rows;
 * - **kick** — `state.waitUntil(engine.burst(key))`: execution rides
 *   DO events; parking is returning;
 * - **broadcast** — hibernatable WebSockets, re-read from the runtime
 *   per frame (no RAM session state to lose);
 * - **remind / recovery re-entry** — `remind:` rows + ONE alarm,
 *   re-armed to the earliest deadline;
 * - **verbs** — the {@link SessionRpc} surface, uniform across every
 *   agent, which is what makes delegation cross-DO for free.
 *
 * ## How a charter reaches the DO
 *
 * A charter is CODE and cannot cross the wire — and it doesn't need
 * to: the Worker and its DO classes share ONE memoized layer build
 * per isolate (`WorkerBridge.getSharedBuild`), and the class-level
 * `layers` slot IS that build. So the agent layers build on the DO
 * side too, their `interpret` calls record `term → {charter,
 * captured context}` in this module's registrations, and the
 * `AgentSessions` DO — declared here, discovered as a binding because
 * the layer yields it during init — closes over that same map. An
 * activating DO parses its own name and becomes that session.
 */
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { Actor, SessionRef } from "../../AI/Agent.ts";
import { Sandbox, type SandboxPty } from "../../AI/Sandbox.ts";
import { Thread, type ThreadService } from "../../AI/Thread.ts";
import { Driver, type Charter, type Interpretable } from "../../AI/Driver.ts";
import {
  makeSessionEngine,
  reminderInput,
  stoppedByOperator,
  type SessionEngine,
} from "../../AI/DriverCore.ts";
import type { DriverError } from "../../AI/Errors.ts";
import { SessionIndex, sessionId } from "../../AI/SessionIndex.ts";
import {
  handleSessionSocketFrame,
  type SessionSocketClientFrame,
  type SessionSocketServerFrame,
} from "../../AI/SessionSocket.ts";
import { Sessions } from "../../AI/Sessions.ts";
import type { ThreadStorageService } from "../../AI/ThreadStorage.ts";
import { makeThreadStorageMemory } from "../../AI/ThreadStorageMemory.ts";
import type { HttpEffect } from "../../Http.ts";
import type { MainRpc } from "../../Platform.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import { DurableObject, DurableObjectScope } from "../Workers/DurableObject.ts";
import { ALCHEMY_PHASE } from "../../Phase.ts";
import { SessionContainerImage } from "./SessionContainer.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import { makeDurableObjectStore } from "../Workers/PersistentRefStore.ts";
import {
  upgrade,
  type RawWebSocket,
  type WebSocket,
} from "../Workers/WebSocket.ts";
import { Worker } from "../Workers/Worker.ts";
import {
  makeThreadStorageDurableObject,
  REMIND,
  seqKey,
  seqOf,
} from "./ThreadStorageDurableObject.ts";

/** What one `interpret` call recorded — all a DO activation needs to
 *  BECOME a session of its term. */
interface RegisteredCharter {
  readonly charter: Charter;
  /** The charter's own Layer graph, captured at interpret — tools,
   *  doors, and delegates resolve from it as on the resident
   *  placement. */
  readonly context: Context.Context<never>;
  readonly term: Interpretable;
}

/** The DO name addressing one session of one term: `${term}/${key}`. */
const sessionName = (termName: string, key: string) => `${termName}/${key}`;

/**
 * A TERMINAL socket's hibernation-surviving identity, stamped on the
 * socket at accept (`serializeAttachment`). The dimensions ride along
 * (updated on open/resize) so a wake after hibernation — or a machine
 * that lost its PTY (idle suspend, image recycle) — can reopen the
 * shell at the viewer's real size without asking the client anything.
 */
interface TerminalAttachment {
  readonly kind: "terminal";
  /** The PTY id on the session's machine (one shared shell: "main"). */
  readonly id: string;
  readonly cols: number;
  readonly rows: number;
}

/** Hibernation-surviving accept tags: chat views vs terminal views —
 *  so the session-frame broadcast never writes into a terminal. */
const SESSION_SOCKET_TAG = "session";
const TERMINAL_SOCKET_TAG = "terminal";

const isTerminalAttachment = (value: unknown): value is TerminalAttachment =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  value.kind === "terminal" &&
  "id" in value;

/** Control frames the terminal client sends as TEXT (keystrokes are
 *  BINARY frames — raw stdin, no envelope). */
type TerminalClientFrame =
  | { readonly t: "open"; readonly cols: number; readonly rows: number }
  | { readonly t: "resize"; readonly cols: number; readonly rows: number }
  /** Kill the shell and drop the PTY — the tab's ×, not a detach. */
  | { readonly t: "close" };

/**
 * A PHANTOM thread identity — just enough `AI.Thread` for the sandbox
 * layer to derive the session's MACHINE (it only reads `key`). The
 * terminal bridge is out-of-session by nature: no round is running
 * when an operator types, so the session's machine is addressed by
 * key alone — the same trick the org's worker-level exec door uses.
 */
const phantomThread = (key: string): ThreadService => ({
  key,
  tokens: Effect.succeed(0),
  entries: Effect.succeed([]),
  compact: () => Effect.void,
  reply: () => Effect.void,
  remind: () => Effect.void,
});

/** Split a DO name back into its term and key halves. The key may
 *  itself contain slashes (session keys are `${parent}/${agent}/${s}`),
 *  so only the FIRST segment is the term. */
const parseSessionName = (name: string) => {
  const at = name.indexOf("/");
  return at < 0
    ? { term: name, key: name }
    : { term: name.slice(0, at), key: name.slice(at + 1) };
};

/**
 * Tuning for the recovery machinery — optional; tests shrink it so
 * recovery is observable in seconds.
 */
export class DriverDurability extends Context.Service<
  DriverDurability,
  {
    /** Base delay before the recovery alarm re-enters a silent round
     *  (doubles per attempt, capped at 8×). @default 30 seconds */
    readonly recoverAfterMillis?: number;
    /** Re-entries on the same round before it is abandoned with an
     *  interruption note. @default 5 */
    readonly maxAttempts?: number;
  }
>()("alchemy/Cloudflare/AI/DriverDurability") {}

/**
 * A session's RPC surface — the {@link Actor} verbs, as one DO speaks
 * them. Uniform across every agent, which is what makes delegation
 * cross-DO for free: a door fired inside a session calls these on the
 * delegate's own instance.
 */
interface SessionRpc extends MainRpc<DurableObjectState> {
  readonly deliver: (
    input: unknown,
    options?: { readonly parent?: SessionRef; readonly wake?: boolean },
  ) => Effect.Effect<void, unknown, RuntimeContext>;
  readonly dispatch: (
    input: unknown,
    options?: { readonly parent?: SessionRef },
  ) => Effect.Effect<unknown, unknown, RuntimeContext>;
  readonly steer: (
    input: unknown,
  ) => Effect.Effect<void, unknown, RuntimeContext>;
  readonly settle: (
    outcome: unknown,
  ) => Effect.Effect<void, unknown, RuntimeContext>;
  /** Admit this session durably without input (the operator's "new
   *  session") — it lists at once; init runs on the first input. */
  readonly open: () => Effect.Effect<void, unknown, RuntimeContext>;
  /** Reopen a settled session (the operator's undo for `stop`). */
  readonly resume: () => Effect.Effect<void, unknown, RuntimeContext>;
  /** Erase this session: settle, detach views, purge storage.
   *  `machine` (default true) also terminates the session's sandbox
   *  machine — pass false when sibling threads still share it. */
  readonly destroy: (
    machine?: boolean,
  ) => Effect.Effect<void, unknown, RuntimeContext>;
  readonly alarm: () => Effect.Effect<void, unknown, RuntimeContext>;
  /** The live-view seam: WebSocket attach + the session-socket frames. */
  readonly fetch: HttpEffect<DurableObjectState | RuntimeContext>;
  readonly webSocketMessage: (
    socket: WebSocket,
    message: string | ArrayBuffer,
  ) => Effect.Effect<void>;
  readonly webSocketClose: (
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ) => Effect.Effect<void>;
}

export { Sessions } from "../../AI/Sessions.ts";

/**
 * The `AI.Driver` for Cloudflare — no argument, and no class for the
 * user to declare: the sessions DO is declared in this module and
 * discovered as a binding because this layer YIELDS it while building.
 *
 * It requires `Worker` for exactly that reason: the binding attaches
 * to the host whose bundle carries the class, so this layer only
 * builds inside a Worker (or a DO of one). That is the whole
 * difference from `AI.DriverLocal`'s `Layer<Driver, never,
 * LanguageModel | ThreadStorage>` — the substrate is in the type.
 */
export const DurableObjectHost: Layer.Layer<
  Driver | Sessions,
  never,
  LanguageModel.LanguageModel | Worker
> = Layer.unwrap(
  Effect.gen(function* () {
    const languageModel = yield* LanguageModel.LanguageModel;
    // `Sessions.list` delegates to whatever index the assembly
    // composed in; absent an index, the population is unlistable
    const sessionIndex = yield* Effect.serviceOption(SessionIndex);
    const registrations = new Map<string, RegisteredCharter>();

    /**
     * The sessions namespace: ONE Durable Object for every agent — the
     * term prefix of the instance name says which charter an
     * activation becomes. Declared HERE, not by the user, and closed
     * over `registrations`, which the shared layer build populates
     * before any activation's constructor runs.
     */
    const sessions = yield* DurableObject<SessionRpc>()(
      "AgentSessions",
      Effect.gen(function* () {
        const state = yield* DurableObjectState;
        const storage = state.storage;
        const store = makeThreadStorageDurableObject(state);
        /**
         * WHO THIS ACTIVATION IS, read lazily. The constructor's outer
         * effect also runs at PLAN time — against a mock state with no
         * id — to discover this binding, so nothing here may touch the
         * instance eagerly. Every read below happens inside a
         * request-time effect.
         */
        let identity:
          | { readonly term: string; readonly key: string }
          | undefined;
        const me = {
          get term() {
            return (identity ??= parseSessionName(String(state.id.name))).term;
          },
          get key() {
            return (identity ??= parseSessionName(String(state.id.name))).key;
          },
        };

        const captured = yield* Effect.context<never>();
        // this namespace's own handle (provided by the DO machinery to
        // the constructor) — re-provided into each session's context so
        // call-time capabilities (the attached container) can bind to it
        const doScope = yield* DurableObject;

        // The OPTIONAL per-session container ({@link SessionContainerImage}):
        // its attachment to THIS namespace must be registered at PLAN
        // time, and this constructor is the only plan-evaluated site
        // that carries the namespace scope. PLAN-ONLY by design: at
        // runtime the bind belongs to the session's own call-time path
        // (`SandboxContainerSession`), never the activation constructor
        // — a constructor-time bind would run inside the worker's first
        // event, where the loopback machinery it touches can deadlock.
        const phase = yield* ALCHEMY_PHASE;
        const sessionContainer = yield* SessionContainerImage;
        if (phase === "plan" && sessionContainer !== undefined) {
          yield* (
            sessionContainer as never as {
              "~alchemy/Container/Binding": Effect.Effect<unknown>;
            }
          )["~alchemy/Container/Binding"];
        }
        const durability = Option.getOrElse(
          Context.getOption(captured, DriverDurability),
          () => ({}) as (typeof DriverDurability)["Service"],
        );
        const recoverAfter = durability.recoverAfterMillis ?? 30_000;

        // storage is a RUNTIME capability; everything here only ever
        // runs inside a DO event, so seal once
        const sealed = <A, E>(
          effect: Effect.Effect<A, E, RuntimeContext>,
        ): Effect.Effect<A, E> =>
          Effect.provide(effect, RuntimeContext.phantom);

        /**
         * ONE alarm, re-armed to the earliest of its consumers: the
         * next reminder, and any recovery deadline the engine asks
         * for. A stale alarm firing after the work is done just
         * parks — never cleared, only outraced.
         */
        const armAlarm = (extraDeadline?: number) =>
          sealed(
            Effect.gen(function* () {
              const reminders = yield* store.listRows<string>(REMIND);
              const deadlines = reminders.map(([k]) => seqOf(REMIND, k));
              if (extraDeadline !== undefined) deadlines.push(extraDeadline);
              const meta = yield* store.readMeta;
              if (meta.busy !== undefined && meta.settled === undefined) {
                deadlines.push(
                  meta.busy.since +
                    recoverAfter * 2 ** Math.min(meta.busy.attempts, 3),
                );
              }
              if (deadlines.length === 0) return;
              yield* storage
                .setAlarm(Math.min(...deadlines))
                .pipe(Effect.orDie);
            }),
          );

        /**
         * Fan a wire frame out to every attached socket. `sendIfOpen`
         * discipline: a closing socket's send throws and is IGNORED —
         * the client owns catch-up via `subscribe {fromSeq}`, so a
         * dropped frame is never an error, only a gap the cursor
         * closes. Sockets are re-read from the runtime each time (no
         * in-memory session map to rehydrate after hibernation).
         */
        const broadcast = (frame: SessionSocketServerFrame) =>
          sealed(
            Effect.gen(function* () {
              const attached = yield* state.getWebSockets(SESSION_SOCKET_TAG);
              if (attached.length === 0) return;
              const data = JSON.stringify(frame);
              for (const socket of attached) {
                yield* Effect.ignore(Effect.try(() => socket.ws.send(data)));
              }
            }),
          );

        // ------------------------------------------------------------------
        // THE TERMINAL BRIDGE — hibernatable browser socket ⇄ the session
        // machine's PTY. The only in-RAM state is the map of live output
        // PUMPS (one per attached terminal socket, forwarding the guest's
        // pty stream to that viewer); everything durable — which socket is
        // a terminal, which PTY id, the viewer's dimensions — rides the
        // socket's attachment. A wake after hibernation rebuilds the pump
        // on the first frame; the guest's ring buffer repaints the screen.
        // ------------------------------------------------------------------
        const pumps = new Map<RawWebSocket, Deferred.Deferred<void>>();

        /**
         * The session machine's PTY surface, resolved from the charter's
         * captured Layer context — the SAME `AI.Sandbox` build the tools
         * use (deduped by the layer MemoMap), so the terminal lands on
         * the session's own machine. Absent when the placement's sandbox
         * has no PTY (or the term registered no sandbox at all).
         *
         * TODO(placement): the terminal bridge living in the DRIVER
         * couples it to "the one `AI.Sandbox` of the term" — a charter
         * with two sandboxes (or none at the term level) has no say in
         * which machine an operator terminal reaches. The driver should
         * stay generic; the bridge wants to be its own seam (a charter-
         * declared door, like tools) once the end-to-end shape settles.
         */
        const sandboxPty = (): SandboxPty | undefined => {
          const registration = registrations.get(me.term);
          if (registration === undefined) return undefined;
          return Option.getOrUndefined(
            Context.getOption(registration.context, Sandbox),
          )?.pty;
        };

        /**
         * The session machine's LIFECYCLE, resolved like
         * {@link sandboxPty} from the charter's captured context: a
         * SETTLED session's machine is suspended (snapshot — the idle
         * policy reaps it from there), a REMOVED session's machine is
         * terminated. Both hooks are BEST-EFFORT and contained —
         * machine hygiene must never block the session's own
         * lifecycle, and a sandbox without a `lifecycle` (the trusted
         * host) is a no-op.
         */
        const machineLifecycle = (
          verb: "suspend" | "resume" | "destroy",
        ): Effect.Effect<void> =>
          Effect.suspend(() => {
            const registration = registrations.get(me.term);
            const lifecycle =
              registration === undefined
                ? undefined
                : Option.getOrUndefined(
                    Context.getOption(registration.context, Sandbox),
                  )?.lifecycle;
            const effect =
              lifecycle === undefined
                ? undefined
                : verb === "suspend"
                  ? lifecycle.suspend
                  : verb === "resume"
                    ? lifecycle.resume
                    : lifecycle.destroy;
            if (effect === undefined) return Effect.void;
            return asSession(effect).pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  `sandbox ${verb} for '${me.term}/${me.key}' failed (contained): ${error}`,
                ),
              ),
            );
          });

        /** Out-of-session machine addressing: the sandbox layer reads
         *  only `Thread.key` to derive the machine — provide the
         *  session's own key (the org's worker-level exec door does the
         *  same). */
        const asSession = <A, E>(
          effect: Effect.Effect<A, E>,
        ): Effect.Effect<A, E> =>
          Effect.provideService(effect, Thread, phantomThread(me.key));

        /** Surface a terminal failure to the viewer as a control frame —
         *  never into the DO's error channel. */
        const notify = (socket: WebSocket, message: string) =>
          Effect.ignore(socket.send(JSON.stringify({ t: "error", message })));

        /** PROGRESS a viewer can render (machine launching, waking from
         *  suspend) — not an error: the client shows it until the PTY's
         *  first output proves the machine is live. */
        const notifyStatus = (socket: WebSocket, message: string) =>
          Effect.ignore(socket.send(JSON.stringify({ t: "status", message })));

        const haltPump = (socket: WebSocket) =>
          Effect.suspend(() => {
            const halt = pumps.get(socket.ws);
            if (halt === undefined) return Effect.void;
            pumps.delete(socket.ws);
            return Effect.asVoid(Deferred.succeed(halt, void 0));
          });

        /**
         * Guarantee ONE live pump for this viewer: the guest's
         * `pty.stream` (retained tail first, then live) forwarded to the
         * socket as binary frames. Rides `waitUntil` exactly like the
         * engine's kick — an ACTIVE terminal pins the DO awake, an idle
         * (closed-pump) one hibernates. A guest-side failure ends the
         * pump and tells the viewer; the next keystroke reopens.
         */
        const ensurePump = (
          socket: WebSocket,
          pty: SandboxPty,
          tag: TerminalAttachment,
          options?: { readonly restart?: boolean },
        ) =>
          Effect.gen(function* () {
            if (pumps.has(socket.ws)) {
              if (options?.restart !== true) return;
              yield* haltPump(socket);
            }
            const halt = yield* Deferred.make<void>();
            pumps.set(socket.ws, halt);
            let chunks = 0;
            const pump = Effect.raceFirst(
              pty.stream(tag.id).pipe(
                Stream.runForEach((chunk) =>
                  Effect.gen(function* () {
                    if (chunks++ === 0) {
                      yield* Effect.logDebug(
                        `[terminal-debug] pump(${tag.id}): first chunk (${(chunk as Uint8Array).byteLength}b)`,
                      );
                    }
                    yield* socket.send(chunk);
                  }),
                ),
                asSession,
                Effect.tap(() =>
                  Effect.logDebug(
                    `[terminal-debug] pump(${tag.id}): stream ended after ${chunks} chunks`,
                  ),
                ),
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    yield* Effect.logDebug(
                      `[terminal-debug] pump(${tag.id}): failed: ${String(error)}`,
                    );
                    yield* notify(socket, String(error));
                  }),
                ),
                Effect.catchDefect((defect) =>
                  Effect.logDebug(
                    `[terminal-debug] pump(${tag.id}): died: ${
                      defect instanceof Error
                        ? (defect.stack ?? defect.message)
                        : String(defect)
                    }`,
                  ),
                ),
              ),
              Deferred.await(halt),
            ).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (pumps.get(socket.ws) === halt) pumps.delete(socket.ws);
                }),
              ),
            );
            yield* sealed(state.waitUntil(pump));
          });

        /** One write of keystrokes to the PTY, waking the machine if
         *  it has no shell. */
        const writeInput = (
          socket: WebSocket,
          tag: TerminalAttachment,
          pty: NonNullable<ReturnType<typeof sandboxPty>>,
          data: string,
        ) =>
          asSession(pty.input(tag.id, data)).pipe(
            Effect.andThen(ensurePump(socket, pty, tag)),
            // no shell (fresh machine) or stale pump: reopen at the
            // attachment's dimensions and retry the keystrokes once
            Effect.catch(() =>
              Effect.gen(function* () {
                // the keystroke is the WAKE signal — the machine was
                // suspended or recycled; the reopen blocks through the
                // resume, so show the viewer what the wait is
                yield* notifyStatus(socket, "waking the session's machine");
                yield* asSession(pty.open(tag.id, tag.cols, tag.rows));
                yield* ensurePump(socket, pty, tag, { restart: true });
                yield* asSession(pty.input(tag.id, data));
              }).pipe(Effect.catch((error) => notify(socket, error))),
            ),
          );

        /**
         * Keystrokes reach the PTY strictly IN ORDER. Every binary frame
         * is one RPC round-trip to the machine and the DO runs frame
         * handlers concurrently, so with any latency independent writes
         * overtake each other — `git status` landed as `igts attsu`.
         * One drain loop per terminal: frames append to its buffer, and
         * the single in-flight write ships whatever accumulated while
         * the previous one was on the wire — ordered, and coalesced
         * into one write per round-trip when the viewer types faster
         * than the link.
         */
        const inputBuffers = new Map<
          string,
          { buffer: string; draining: boolean }
        >();
        const enqueueInput = (
          socket: WebSocket,
          tag: TerminalAttachment,
          pty: NonNullable<ReturnType<typeof sandboxPty>>,
          data: string,
        ) =>
          Effect.suspend(() => {
            const queue = inputBuffers.get(tag.id) ?? {
              buffer: "",
              draining: false,
            };
            inputBuffers.set(tag.id, queue);
            queue.buffer += data;
            if (queue.draining) return Effect.void;
            queue.draining = true;
            const drain: Effect.Effect<void> = Effect.suspend(() => {
              if (queue.buffer.length === 0) return Effect.void;
              const chunk = queue.buffer;
              queue.buffer = "";
              return writeInput(socket, tag, pty, chunk).pipe(
                Effect.andThen(drain),
              );
            });
            return drain.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  queue.draining = false;
                  if (queue.buffer.length === 0) inputBuffers.delete(tag.id);
                }),
              ),
            );
          });

        /**
         * One terminal frame: TEXT is a control frame (open/resize),
         * BINARY is raw keystrokes. Keystrokes double as the WAKE
         * signal: if the machine lost its PTY (idle suspend, image
         * recycle) or this isolate lost its pump (hibernation), the
         * attachment's dimensions reopen the shell right here — the
         * viewer just types and the terminal comes back.
         */
        const terminalFrame = (
          socket: WebSocket,
          tag: TerminalAttachment,
          message: string | ArrayBuffer,
        ) =>
          Effect.gen(function* () {
            const pty = sandboxPty();
            if (pty === undefined) {
              yield* notify(
                socket,
                "terminal unavailable: this placement's sandbox has no PTY surface",
              );
              yield* Effect.ignore(socket.close(1011, "terminal unavailable"));
              return;
            }
            if (typeof message === "string") {
              const frame = JSON.parse(message) as TerminalClientFrame;
              if (frame.t === "open") {
                const next: TerminalAttachment = {
                  ...tag,
                  cols: frame.cols,
                  rows: frame.rows,
                };
                socket.serializeAttachment(next);
                // the machine may be COLD (fresh launch) or SUSPENDED (a
                // stopped session) — pty.open blocks through the whole
                // launch/resume, so tell the viewer what the wait is
                yield* notifyStatus(socket, "starting the session's machine");
                yield* Effect.logDebug(
                  `[terminal-debug] pty.open(${next.id}) starting`,
                );
                yield* asSession(pty.open(next.id, next.cols, next.rows)).pipe(
                  // a machine that cannot launch is a DEFECT of the
                  // sandbox layer (no error channel for it) — the
                  // viewer must still see WHY, not a frozen "starting"
                  Effect.catchCause((cause) =>
                    notify(socket, String(Cause.squash(cause))),
                  ),
                );
                yield* Effect.logDebug(
                  `[terminal-debug] pty.open(${next.id}) done — starting pump`,
                );
                // (re)attach this viewer's pump — the retained tail
                // repaints the screen
                yield* ensurePump(socket, pty, next, { restart: true });
              } else if (frame.t === "resize") {
                socket.serializeAttachment({
                  ...tag,
                  cols: frame.cols,
                  rows: frame.rows,
                } satisfies TerminalAttachment);
                yield* asSession(
                  pty.resize(tag.id, frame.cols, frame.rows),
                ).pipe(Effect.catch((error) => notify(socket, error)));
              } else if (frame.t === "close") {
                // the tab's × — KILL the shell (a detach is just the
                // socket dropping); tolerate an already-gone PTY
                yield* haltPump(socket);
                yield* asSession(pty.close(tag.id)).pipe(Effect.ignore);
                yield* Effect.ignore(socket.close(1000, "terminal closed"));
              }
              return;
            }
            yield* enqueueInput(
              socket,
              tag,
              pty,
              new TextDecoder().decode(message),
            );
          });

        /**
         * The engine, built lazily on the first REQUEST-time touch
         * (the plan-time constructor must not read the instance's
         * identity). One activation = one session of one term; spawn
         * workers ride an in-memory sibling store — they are driven
         * inline by the spawn call and are not restorable by design.
         */
        let engineRef: SessionEngine | undefined;
        const memoryStore = makeThreadStorageMemory();
        const stateStore = makeDurableObjectStore(state);
        const engine = Effect.sync((): SessionEngine => {
          if (engineRef !== undefined) return engineRef;
          const registration = registrations.get(me.term);
          if (registration === undefined) {
            throw new Error(
              `DriverCloudflare: no charter registered for '${me.term}' — is its Layer in the worker's layers slot?`,
            );
          }
          const singleSessionStorage: ThreadStorageService = {
            open: (term, key) =>
              key === me.key
                ? Effect.succeed(store.handle)
                : memoryStore.open(term, key),
            // restore is per-activation on this placement — a DO
            // revives its own session when addressed
            keys: () => Effect.succeed([]),
            remove: (term, key) => memoryStore.remove(term, key),
          };
          engineRef = makeSessionEngine({
            driver: "DriverCloudflare",
            term: me.term,
            charter: registration.charter,
            // the charter's captured context PLUS this instance's own
            // state AND the namespace scope: per-session capabilities
            // (the attached container — `SandboxContainerSession` —
            // and anything else keyed to the DO) resolve them at call
            // time, which is what lets their Layers build in the
            // shared per-isolate graph. The scope rides the CAPTURED
            // constructor context (provided by the DO machinery).
            context: Context.add(
              Context.add(registration.context, DurableObjectState, state),
              DurableObjectScope,
              doScope,
            ) as Context.Context<never>,
            storage: singleSessionStorage,
            languageModel,
            // execution rides DO events; the burst is contained (it
            // never fails), so waitUntil can never be poisoned
            kick: (key) => sealed(state.waitUntil(engineRef!.burst(key))),
            broadcast: (key, frame) =>
              key === me.key ? broadcast(frame) : Effect.void,
            // the CLOCK, durable by construction: a row plus the DO
            // alarm — delivery comes back through `alarm` below
            remind: (key, fireAtMillis, note) =>
              key === me.key
                ? sealed(
                    Effect.gen(function* () {
                      yield* storage.put(seqKey(REMIND, fireAtMillis), note);
                      yield* armAlarm();
                    }),
                  )
                : Effect.void,
            scheduleReentry: (_key, delayMillis) =>
              armAlarm(Date.now() + delayMillis),
            stateStore: () => stateStore,
            // handlers run INSIDE the DO's event, so the runtime
            // capability is already satisfied — seal it once here
            wrapHandler: (handler) => (params) =>
              Effect.provide(
                handler(params),
                RuntimeContext.phantom,
              ) as Effect.Effect<any, any>,
            maxAttempts: durability.maxAttempts,
            recoverAfterMillis: durability.recoverAfterMillis,
          });
          return engineRef;
        });

        return Effect.succeed<SessionRpc>({
          /**
           * The LIVE VIEWS attach here (via {@link Sessions.attach}):
           * accept the WebSocket and hibernate freely — there is no
           * in-memory session state to lose, because `broadcast`
           * re-reads the attached sockets from the runtime every time.
           * TWO kinds of view share the seam, told apart by pathname:
           * chat sockets (`/attach/...`) speak session-socket frames;
           * terminal sockets (`/terminal/...`) are stamped with a
           * hibernation-surviving attachment and bridge to the session
           * machine's PTY.
           */
          fetch: Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const url = new URL(request.url, "http://durable-object");
            const isTerminal = url.pathname.startsWith("/terminal/");
            yield* Effect.logDebug(
              `[terminal-debug] DO fetch url=${request.url} pathname=${url.pathname} isTerminal=${isTerminal}`,
            );
            const [response, socket] = yield* upgrade({
              tags: [isTerminal ? TERMINAL_SOCKET_TAG : SESSION_SOCKET_TAG],
            });
            if (isTerminal) {
              socket.serializeAttachment({
                kind: "terminal",
                id: url.searchParams.get("id") ?? "main",
                cols: 80,
                rows: 24,
              } satisfies TerminalAttachment);
            }
            return response;
          }),
          webSocketMessage: (socket, message) =>
            Effect.gen(function* () {
              const attachment = socket.deserializeAttachment<unknown>();
              yield* Effect.logDebug(
                `[terminal-debug] DO message attachment=${JSON.stringify(attachment)} kind=${typeof message}`,
              );
              if (isTerminalAttachment(attachment)) {
                return yield* terminalFrame(socket, attachment, message);
              }
              const host = yield* (yield* engine).socketHost(me.key);
              yield* handleSessionSocketFrame(host, (frame) =>
                Effect.ignore(socket.send(JSON.stringify(frame))),
              )(
                JSON.parse(
                  typeof message === "string"
                    ? message
                    : new TextDecoder().decode(message),
                ) as SessionSocketClientFrame,
              );
            }).pipe(
              // a malformed frame must never kill the socket's DO
              Effect.catchDefect((defect) =>
                Effect.logWarning(
                  `[session-socket] bad frame: ${
                    defect instanceof Error
                      ? (defect.stack ?? defect.message)
                      : String(defect)
                  }`,
                ),
              ),
              Effect.provide(RuntimeContext.phantom),
            ) as Effect.Effect<void>,
          webSocketClose: (socket, code, reason) =>
            Effect.gen(function* () {
              // a departed terminal viewer's pump must not pin the DO
              yield* haltPump(socket);
              // 1005/1006/1015 are RESERVED — the runtime reports them
              // for a peer that vanished without a close frame, and
              // throws InvalidAccessError if echoed back
              const echo = code === 1005 || code === 1006 || code === 1015;
              yield* Effect.ignore(
                socket.close(echo ? 1000 : code, echo ? "" : reason),
              );
            }),
          deliver: (
            input: unknown,
            options?: { parent?: SessionRef; wake?: boolean },
          ) =>
            Effect.gen(function* () {
              yield* (yield* engine).send(input, {
                key: me.key,
                parent: options?.parent,
                wake: options?.wake,
              });
            }),
          dispatch: (input: unknown, options?: { parent?: SessionRef }) =>
            Effect.gen(function* () {
              return yield* (yield* engine).dispatch(input, {
                key: me.key,
                parent: options?.parent,
              });
            }),
          steer: (input: unknown) =>
            Effect.gen(function* () {
              yield* (yield* engine).send(input, { key: me.key });
            }),
          settle: (
            outcome: unknown,
          ): Effect.Effect<void, never, RuntimeContext> =>
            Effect.gen(function* () {
              yield* (yield* engine).settle(me.key, outcome, { admit: true });
              // a settled session's machine snapshots itself away
              yield* machineLifecycle("suspend");
            }),
          open: (): Effect.Effect<void, never, RuntimeContext> =>
            Effect.gen(function* () {
              yield* (yield* engine).admit(me.key);
            }),
          resume: (): Effect.Effect<void, never, RuntimeContext> =>
            Effect.gen(function* () {
              yield* (yield* engine).resume(me.key);
              // eagerly wake the suspended machine (best-effort —
              // lazily waking on the next sandbox call is the fallback)
              yield* machineLifecycle("resume");
            }),
          /**
           * The ERASER (`Sessions.remove`): settle first (idempotent —
           * children cascade, attached views see the end), close every
           * hibernatable socket, then purge THIS instance's rows (the
           * transcript, inbox, reminders, meta) and its alarm. The
           * in-RAM engine is dropped too, so the next touch of this
           * name admits a FRESH session over empty storage instead of
           * finding a settled tombstone.
           */
          destroy: (machine = true) =>
            Effect.gen(function* () {
              // settle is BEST-EFFORT and NON-ADMITTING: admitting runs
              // the charter's per-session INIT, whose side effects
              // (checkouts, machine launches) are the OPPOSITE of an
              // erase — deleting a hibernated session must not boot a
              // fresh machine just to settle a tombstone. A RAM-live
              // session still settles properly (children cascade,
              // views see the end); a dormant one has nothing to
              // settle — the purge below is the point of destroy.
              yield* Effect.catchCause(
                Effect.gen(function* () {
                  yield* (yield* engine).settle(me.key, stoppedByOperator);
                }),
                (cause) =>
                  Effect.logWarning(
                    `DriverCloudflare destroy for '${me.term}/${me.key}': settle failed (contained) — purging anyway`,
                    cause,
                  ),
              );
              for (const socket of yield* state.getWebSockets()) {
                yield* Effect.ignore(socket.close(1000, "session removed"));
              }
              // a removed session's machine is terminated, not idled
              // out — unless sibling threads still share it (the
              // caller's directory decides; the last one out carries
              // the teardown)
              if (machine) {
                yield* machineLifecycle("destroy");
              }
              yield* storage.deleteAlarm();
              yield* storage.deleteAll();
              engineRef = undefined;
            }),
          /**
           * The single alarm serves BOTH clocks: due reminders become
           * ordinary inputs, and an open round's recovery deadline
           * re-enters the burst. Re-arming happens AFTER the burst so
           * the alarm reflects the round's final state.
           */
          alarm: () =>
            Effect.gen(function* () {
              const now = Date.now();
              const active = yield* engine;
              const rows = yield* store.listRows<string>(REMIND);
              const due = rows.filter(([k]) => seqOf(REMIND, k) <= now);
              for (const [, note] of due) {
                yield* active.send(reminderInput(note), { key: me.key });
              }
              if (due.length > 0) {
                yield* storage.delete(due.map(([k]) => k)).pipe(Effect.orDie);
              }
              // recovery deadline: re-enter the round (contained —
              // a burst never fails)
              yield* active.burst(me.key);
              yield* armAlarm();
            }).pipe(
              // a failing alarm event must be CONTAINED: workerd's own
              // alarm retry would race our bounded one (and a repeated
              // failure resets the object) — log, best-effort re-arm,
              // and let our recovery machinery own the re-entry
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  yield* Effect.logError(
                    `DriverCloudflare alarm for '${me.term}/${me.key}' failed (contained)`,
                    cause,
                  );
                  yield* Effect.ignore(armAlarm());
                }),
              ),
            ),
        });
      }),
    );
    let minted = 0;
    const mintPrefix = crypto.randomUUID().slice(0, 8);

    const interpret = (term: Interpretable, charter: Charter) =>
      Effect.gen(function* () {
        const termName = term["~alchemy/Name"];
        registrations.set(termName, {
          charter,
          context: yield* Effect.context<never>(),
          term,
        });

        const stub = (key: string) =>
          sessions.getByName(sessionName(termName, key));
        const mint = () => `session-${mintPrefix}-${minted++}`;

        return {
          send: (item: unknown, options?: Parameters<Actor["send"]>[1]) =>
            stub(options?.key ?? mint())
              .deliver(item, { parent: options?.parent, wake: options?.wake })
              .pipe(Effect.orDie, Effect.asVoid),
          dispatch: (
            item: unknown,
            options?: Parameters<Actor["dispatch"]>[1],
          ) =>
            stub(options?.key ?? mint())
              .dispatch(item, { parent: options?.parent })
              .pipe(Effect.orDie),
          steer: ((first: unknown, second?: unknown) =>
            second === undefined
              ? Effect.die(
                  new Error(
                    "DriverCloudflare: steer requires a key — steer(key, input)",
                  ),
                )
              : stub(first as string)
                  .steer(second)
                  .pipe(Effect.orDie, Effect.asVoid)) as Actor["steer"],
          settle: (sessionKey: string, outcome: unknown) =>
            stub(sessionKey).settle(outcome).pipe(Effect.orDie, Effect.asVoid),
          interrupt: () =>
            Effect.die(
              new Error(
                "DriverCloudflare: interrupt() is process-local; settle sessions by key instead",
              ),
            ),
        } as Actor;
      }) as Effect.Effect<Actor, DriverError, never>;

    /** The gateway: route a WebSocket upgrade into the session's own
     *  DO. */
    const attach = (
      term: string,
      key: string,
      request: HttpServerRequest.HttpServerRequest,
    ) =>
      sessions
        .getByName(sessionName(term, key))
        .fetch(request)
        .pipe(Effect.orDie) as Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        never,
        RuntimeContext
      >;

    return Layer.mergeAll(
      Layer.succeed(Driver, { interpret }),
      Layer.succeed(Sessions, {
        attach,
        list: () =>
          Option.match(sessionIndex, {
            onNone: () => Effect.succeed([]),
            onSome: (index) => index.list(),
          }),
        // both verbs address the session's own DO — placement
        // knowledge, exactly like attach
        open: (term, key) =>
          sessions
            .getByName(sessionName(term, key))
            .open()
            .pipe(Effect.orDie, Effect.asVoid),
        stop: (term, key) =>
          sessions
            .getByName(sessionName(term, key))
            .settle(stoppedByOperator)
            .pipe(Effect.orDie, Effect.asVoid),
        resume: (term, key) =>
          sessions
            .getByName(sessionName(term, key))
            .resume()
            .pipe(Effect.orDie, Effect.asVoid),
        remove: (term, key, options) =>
          Effect.gen(function* () {
            yield* sessions
              .getByName(sessionName(term, key))
              .destroy(options?.machine ?? true)
              .pipe(Effect.orDie);
            yield* Option.match(sessionIndex, {
              onNone: () => Effect.void,
              onSome: (index) => index.remove(sessionId(term, key)),
            });
          }),
      }),
    );
  }),
);

/**
 * The composed Cloudflare driver: the Durable Object PLACEMENT of the
 * session engine over Durable Object storage — one name for the
 * assembly every Worker wants.
 */
export const DriverCloudflare = DurableObjectHost;
