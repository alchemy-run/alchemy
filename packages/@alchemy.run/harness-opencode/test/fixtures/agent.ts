import type {
  CodingAgentError,
  CodingAgentEvent,
  CodingAgentMessage,
} from "alchemy/AI";
import { CodingAgentContainer } from "alchemy/Cloudflare";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

/** Lifecycle phase broadcast to clients so the UI can show what's happening. */
type AgentStatus = { phase: "starting" | "ready" | "error"; detail?: string };

/** Durable-storage keys for the session store. */
const CURRENT_KEY = "currentSession";
const SESSIONS_KEY = "sessions";

/**
 * Keep the embedded container warm for (effectively) the DO's whole life so the
 * persistent OpenCode session/bridge doesn't get torn down between turns. The
 * container sleeps only after this much inactivity.
 */
const KEEP_ALIVE_MS = 6 * 60 * 60 * 1000;

/**
 * The Agent Durable Object: a durable wrapper around the embedded
 * {@link CodingAgentContainer} that owns a **session store**.
 *
 * The DO is the durable identity; the container is ephemeral. The DO persists
 * the active session id (and a registry of known sessions) in its own storage,
 * keeps the container alive for its lifetime, and re-asserts the active session
 * on every (re)start via {@link CodingAgentContainer.switchSession} — so the
 * session survives container restarts. `switchSession` lets a client start or
 * switch conversations; the container reuses one running bridge per session.
 *
 * - Control methods (`send`, `interrupt`, `readFile`, `listFiles`, `poll`) are
 *   plain RPC forwards to the container.
 * - WebSocket clients are served by a per-socket pump over the container's live
 *   event stream (`container.events()`), forwarding each event as a frame.
 */
export default class Agent extends Cloudflare.DurableObjectNamespace<Agent>()(
  "Agent",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const container = yield* CodingAgentContainer;

    return Effect.gen(function* () {
      const storage = state.storage;

      // ── Lifecycle status broadcast ───────────────────────────────────────
      // The container's boot / session-open phases happen server-side and the
      // client can't infer them from the event stream, so the DO tracks a
      // coarse phase and pushes it to every socket (and to each fresh socket on
      // connect). The client derives `working`/`idle` from the event stream.
      const status = yield* Ref.make<AgentStatus>({
        phase: "starting",
        detail: "starting container…",
      });

      const broadcast = (frame: unknown) =>
        state
          .getWebSockets()
          .pipe(
            Effect.flatMap((sockets) =>
              Effect.forEach(
                sockets,
                (s) =>
                  s
                    .send(JSON.stringify(frame))
                    .pipe(Effect.catchCause(() => Effect.void)),
                { discard: true },
              ),
            ),
          );

      const setStatus = (phase: AgentStatus["phase"], detail?: string) =>
        Ref.set(status, { phase, detail }).pipe(
          Effect.andThen(broadcast({ _tag: "Status", phase, detail })),
        );

      // ── Session store ────────────────────────────────────────────────────
      const listSessions = storage
        .get<string[]>(SESSIONS_KEY)
        .pipe(Effect.map((s) => s ?? []));

      const persistSession = (sessionId: string) =>
        Effect.gen(function* () {
          const sessions = yield* listSessions;
          const next = sessions.includes(sessionId)
            ? sessions
            : [...sessions, sessionId];
          yield* storage.put<string>(CURRENT_KEY, sessionId);
          yield* storage.put<string[]>(SESSIONS_KEY, next);
        });

      // Load (or initialize) the durable active session id.
      const stored = yield* storage.get<string>(CURRENT_KEY);
      const activeSessionId =
        stored ?? (yield* Effect.sync(() => crypto.randomUUID()));
      if (stored === undefined) yield* persistSession(activeSessionId);

      // Keep the container alive and (re)assert the durable session in the
      // background, so a DO wake / container restart resumes the same session id
      // without blocking init. `switchSession` boots the bridge once; the next
      // `send` reuses it.
      yield* Effect.forkDetach(
        container.setInactivityTimeout(KEEP_ALIVE_MS).pipe(
          Effect.andThen(setStatus("starting", "starting agent…")),
          Effect.andThen(container.switchSession(activeSessionId)),
          Effect.andThen(setStatus("ready", "agent ready")),
          Effect.catchCause(() => setStatus("error", "agent failed to start")),
        ),
      );

      // ── WebSocket pump: container live event stream → socket frames ──────
      const pump = (socket: Cloudflare.DurableWebSocket) =>
        container.events().pipe(
          Stream.runForEach((event: CodingAgentEvent) =>
            socket.send(JSON.stringify(event)),
          ),
          Effect.catchCause(() => Effect.void),
        );

      const startPump = (socket: Cloudflare.DurableWebSocket) =>
        Effect.forkDetach(pump(socket)).pipe(Effect.asVoid);

      // Keep idle sockets alive: the runtime auto-replies "pong" to a client
      // "ping" frame WITHOUT waking the DO, so a quiet stream (between turns)
      // doesn't get dropped by idle timeouts.
      yield* state
        .setWebSocketAutoResponse(
          new (globalThis as any).WebSocketRequestResponsePair("ping", "pong"),
        )
        .pipe(Effect.catchCause(() => Effect.void));

      const existing = yield* state.getWebSockets();
      for (const socket of existing) yield* startPump(socket);

      return {
        send: (input: CodingAgentMessage) => container.send(input),
        interrupt: (): Effect.Effect<void, CodingAgentError> =>
          container.interrupt(),
        poll: (
          cursor: number,
        ): Effect.Effect<
          { events: ReadonlyArray<CodingAgentEvent>; cursor: number },
          CodingAgentError
        > => container.poll(cursor),
        readFile: (
          path: string,
        ): Effect.Effect<string | null, CodingAgentError> =>
          container.readFile(path),
        listFiles: (
          path?: string,
        ): Effect.Effect<ReadonlyArray<string>, CodingAgentError> =>
          container.listFiles(path),

        /** List every session id this agent has stored. */
        listSessions: () => listSessions,
        /** The active session id (durably persisted). */
        currentSession: () =>
          storage
            .get<string>(CURRENT_KEY)
            .pipe(Effect.map((id) => id ?? activeSessionId)),
        /**
         * Start or switch to a session. With no id, a fresh session is created.
         * Persists it as the active session, registers it, and points the
         * container's bridge at it. Returns the now-active id.
         */
        switchSession: (sessionId?: string) =>
          Effect.gen(function* () {
            const id =
              sessionId ?? (yield* Effect.sync(() => crypto.randomUUID()));
            yield* persistSession(id);
            yield* setStatus("starting", "switching session…");
            yield* container.switchSession(id);
            yield* setStatus("ready", "agent ready");
            return id;
          }),

        fetch: Effect.gen(function* () {
          const [response, socket] = yield* Cloudflare.upgrade();
          yield* startPump(socket);
          // Tell the freshly-connected socket the current phase so a reloaded
          // page shows "ready" / "starting…" immediately.
          const s = yield* Ref.get(status);
          yield* socket
            .send(JSON.stringify({ _tag: "Status", ...s }))
            .pipe(Effect.catchCause(() => Effect.void));
          return response;
        }),

        webSocketClose: Effect.fn(function* (
          socket: Cloudflare.DurableWebSocket,
          code: number,
          reason: string,
        ) {
          // Reserved codes (1005 "no status", 1006 abnormal, 1015 TLS) can't be
          // passed back to `close()` — doing so throws InvalidAccessError. When
          // the peer closed with one, substitute a normal-closure code.
          const safeCode =
            code === 1005 || code === 1006 || code === 1015 ? 1000 : code;
          yield* socket.close(safeCode, reason);
        }),
      };
    });
  }).pipe(
    Effect.provide(
      Cloudflare.layerContainer(CodingAgentContainer, { enableInternet: true }),
    ),
  ),
) {}
