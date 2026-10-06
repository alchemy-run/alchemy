import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { RuntimeContext } from "../RuntimeContext.ts";
import {
  emptyUsage,
  promptBlocks,
  SessionError,
  Unsupported,
  type Answer,
  type Capabilities,
  type ContentBlock,
  type Harness,
  type Session,
  type SessionEventInput,
  type SessionInfo,
  type SessionState,
  type StartSession,
  type TurnResult,
  type Usage,
} from "./Session.ts";
import { SessionStore } from "./SessionStore.ts";

/** What a driver needs to open one native session. */
export interface DriverSessionOptions {
  readonly id: string;
  readonly cwd: string;
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly approvals: "auto" | "ask";
  readonly account?: string;
  /**
   * Report a normalized event. The engine stamps cursor/session/time,
   * persists it, and tracks session state from it (`turn.started`,
   * `turn.completed`, `permission.requested`).
   */
  readonly emit: (event: SessionEventInput) => Effect.Effect<void>;
}

/** One native harness session, as the engine drives it. */
export interface DriverSession {
  /** Start a turn. Emit `turn.started` … `turn.completed` for `turnId`. */
  readonly prompt: (
    turnId: string,
    prompt: ReadonlyArray<ContentBlock>,
  ) => Effect.Effect<void, SessionError>;
  /** Native mid-turn steering. Omit to degrade to interrupt-and-restart. */
  readonly steer?: (prompt: ReadonlyArray<ContentBlock>) => Effect.Effect<void, SessionError>;
  readonly interrupt: () => Effect.Effect<void, SessionError>;
  readonly respond: (requestId: string, answer: Answer) => Effect.Effect<void, SessionError>;
  /** Native fork. Omit when unsupported. */
  readonly fork?: (
    id: string,
    options: DriverSessionOptions,
  ) => Effect.Effect<DriverSession, SessionError, Scope.Scope>;
}

/** A harness's native integration: opens sessions in the ambient scope. */
export interface HarnessDriver {
  readonly name: string;
  readonly capabilities: Capabilities;
  /** The working directory sessions default to. */
  readonly defaultCwd: string;
  readonly open: (
    options: DriverSessionOptions,
  ) => Effect.Effect<DriverSession, SessionError, Scope.Scope>;
  /** Prepare the workspace for a session (git checkout); default: no-op. */
  readonly checkout?: (
    cwd: string,
    checkout: { readonly ref: string; readonly branch?: string },
  ) => Effect.Effect<void, SessionError>;
}

interface Entry {
  readonly session: Session;
  readonly scope: Scope.Closeable;
  state: SessionState;
  usage: Usage;
  readonly cwd: string;
  lastTurnId: string | undefined;
}

const newId = () => crypto.randomUUID();

const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  ...(a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined
    ? { cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0) }
    : {}),
  ...(a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined
    ? { cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0) }
    : {}),
  ...(a.costUsd !== undefined || b.costUsd !== undefined
    ? { costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0) }
    : {}),
});

/**
 * Build a {@link Harness} from a native driver. The engine owns everything
 * harness-independent: session ids and registry, the event log
 * ({@link SessionStore}), state tracking, `result()` (awaiting a turn's
 * `turn.completed`), steering degradation (interrupt-and-restart), and
 * session lifetimes (each session's native resources live in its own scope,
 * closed by `close()` or when the harness's scope closes).
 */
export const makeHarness = (
  driver: HarnessDriver,
): Effect.Effect<Harness, never, SessionStore | Scope.Scope> =>
  Effect.gen(function* () {
    const store = yield* SessionStore;
    const harnessScope = yield* Scope.Scope;
    const sessions = new Map<string, Entry>();
    const notFound = (id: string) =>
      new SessionError({ sessionId: id, message: `no session ${id} on ${driver.name}` });

    const info = (entry: Entry): Effect.Effect<SessionInfo> =>
      Effect.map(store.latest(entry.session.id), (cursor) => ({
        id: entry.session.id,
        harness: driver.name,
        state: entry.state,
        capabilities: driver.capabilities,
        usage: entry.usage,
        cwd: entry.cwd,
        cursor,
      }));

    const awaitTurn = (sessionId: string, turnId: string | undefined) =>
      store.read(sessionId).pipe(
        Stream.filter(
          (e) =>
            (e.type === "turn.completed" && (turnId === undefined || e.turnId === turnId)) ||
            (e.type === "state" && e.state === "closed"),
        ),
        Stream.runHead,
        Effect.flatMap((first) =>
          first._tag === "Some" && first.value.type === "turn.completed"
            ? Effect.succeed(first.value.result)
            : Effect.fail(
                new SessionError({
                  sessionId,
                  message: `session closed before turn ${turnId ?? "(latest)"} completed`,
                }),
              ),
        ),
      );

    const open = (
      id: string,
      options: StartSession,
      opener: (o: DriverSessionOptions) => Effect.Effect<DriverSession, SessionError, Scope.Scope>,
    ): Effect.Effect<Session, SessionError, RuntimeContext> =>
      Effect.gen(function* () {
        const cwd = options.cwd ?? driver.defaultCwd;
        const scope = yield* Scope.fork(harnessScope, "sequential");
        let entry: Entry | undefined;
        const emit = (event: SessionEventInput) =>
          Effect.gen(function* () {
            if (entry) {
              if (event.type === "turn.started") entry.state = "running";
              else if (event.type === "permission.requested" || event.type === "question.asked")
                entry.state = "awaiting_input";
              else if (event.type === "turn.completed") {
                entry.state = "idle";
                entry.usage = addUsage(entry.usage, event.result.usage);
              }
            }
            yield* store.append(id, event);
          });
        const driverOptions: DriverSessionOptions = {
          id,
          cwd,
          approvals: options.approvals ?? "auto",
          emit,
          ...(options.model !== undefined ? { model: options.model } : {}),
          ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
          ...(options.account !== undefined ? { account: options.account } : {}),
        };
        if (options.checkout && driver.checkout) yield* driver.checkout(cwd, options.checkout);
        const native = yield* opener(driverOptions).pipe(
          Scope.provide(scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );

        const startTurn = (prompt: ReadonlyArray<ContentBlock>) =>
          Effect.gen(function* () {
            const turnId = newId();
            entry!.lastTurnId = turnId;
            yield* native.prompt(turnId, prompt);
            return { turnId, cursor: yield* store.latest(id) };
          });

        const session: Session = {
          id,
          harness: driver.name,
          capabilities: driver.capabilities,
          prompt: (prompt) => startTurn(promptBlocks(prompt)),
          steer: (prompt) =>
            native.steer
              ? native.steer(promptBlocks(prompt))
              : Effect.gen(function* () {
                  // Degrade: interrupt the running turn, then start the
                  // steering message as a fresh turn.
                  if (entry!.state === "running" || entry!.state === "awaiting_input") {
                    const running = entry!.lastTurnId;
                    yield* native.interrupt();
                    yield* awaitTurn(id, running).pipe(Effect.ignore);
                  }
                  yield* startTurn(promptBlocks(prompt));
                }),
          interrupt: () => native.interrupt(),
          respond: (requestId, answer) =>
            native.respond(requestId, answer).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (entry!.state === "awaiting_input") entry!.state = "running";
                }),
              ),
            ),
          result: (turnId) => awaitTurn(id, turnId ?? entry!.lastTurnId),
          events: (o) => store.read(id, { after: o?.after }),
          info: () => info(entry!),
          fork: () =>
            native.fork
              ? Effect.suspend(() => {
                  const forkId = newId();
                  return open(forkId, { ...options, id: forkId, prompt: undefined }, (o) =>
                    native.fork!(forkId, o),
                  );
                })
              : Effect.fail(new Unsupported({ harness: driver.name, operation: "fork" })),
          close: () =>
            Effect.gen(function* () {
              if (entry!.state === "closed") return;
              entry!.state = "closed";
              yield* Scope.close(scope, Exit.void);
              yield* store.append(id, { type: "state", state: "closed" });
            }),
        };
        entry = { session, scope, state: "idle", usage: emptyUsage, cwd, lastTurnId: undefined };
        sessions.set(id, entry);
        yield* emit({ type: "state", state: "idle" });
        if (options.prompt !== undefined) yield* session.prompt(options.prompt);
        return session;
      });

    return {
      name: driver.name,
      capabilities: driver.capabilities,
      start: (options = {}) =>
        Effect.suspend(() => {
          const id = options.id ?? newId();
          const existing = sessions.get(id);
          // Idempotent by id: a second `start` returns the live session.
          if (existing && existing.state !== "closed") return Effect.succeed(existing.session);
          return open(id, options, driver.open);
        }),
      get: (id) =>
        Effect.suspend(() => {
          const entry = sessions.get(id);
          return entry ? Effect.succeed(entry.session) : Effect.fail(notFound(id));
        }),
      list: () => Effect.forEach([...sessions.values()], info),
    } satisfies Harness;
  });
