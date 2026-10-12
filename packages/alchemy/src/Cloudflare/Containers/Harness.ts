/**
 * A coding-agent harness in a container, kept working across container
 * restarts by the Durable Object that owns it:
 *
 * - Every session's events are mirrored into the Durable Object's storage as
 *   they happen, so history (`list`, `events`) is served from there whether
 *   the container is running, asleep, or gone.
 * - The container's filesystem (the workspace, and each harness's own session
 *   files) is snapshotted when the container shuts down — on `stop()`, and
 *   when the platform stops it (the container reports its `SIGTERM`) — and
 *   restored the next time it starts, so sessions resume where they were.
 *
 * A container that dies without warning (crash, host failure) cannot be
 * snapshotted: it restarts from the latest snapshot, and history in the
 * Durable Object is unaffected.
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  type Harness as AIHarness,
  type Session,
  SessionError,
  type SessionEvent,
  type SessionEventInput,
  SessionInfo,
  StartSession,
} from "../../AI/Session.ts";
import { connectHarness } from "../../AI/SessionRpcs.ts";
import { SessionStore } from "../../AI/SessionStore.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import { toHttpClient } from "../Fetcher.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import { DurableSessionStore } from "../Workers/DurableSessionStore.ts";
import type { Container } from "./Container.ts";
import type { ContainerApplication } from "./ContainerApplication.ts";
import type { ContainerClient, ContainerStartOptions } from "./ContainerClient.ts";
import { makeEgress } from "./Egress.ts";

/** The host the container calls when it is told to shut down. */
export const HARNESS_CONTROL_HOST = "alchemy.internal";

/** Env that makes the container report its `SIGTERM` (see Runtime/Bootstrap/ShutdownSnapshot.ts). */
export const SNAPSHOT_ON_SHUTDOWN = "ALCHEMY_SNAPSHOT_ON_SHUTDOWN";

export interface HarnessOptions {
  /** The container port the harness serves `AI.HarnessRpcs` on. @default 3000 */
  readonly port?: number;
}

/**
 * The harness of a container owned by this Durable Object. `start` runs it
 * (restoring the container's last snapshot); `list` and `events` read this
 * Durable Object's storage and never need the container.
 */
export interface Harness {
  /**
   * Start the container if it isn't running — restoring its latest snapshot
   * — with these options (its `egress` decides what it can reach), and
   * return its harness. Sessions opened or resumed through it are recorded
   * in this Durable Object.
   */
  readonly start: (
    options?: ContainerStartOptions,
  ) => Effect.Effect<AIHarness, SessionError, RuntimeContext>;
  /** Sessions recorded in this Durable Object, newest first. */
  readonly list: () => Effect.Effect<ReadonlyArray<SessionInfo>, never, RuntimeContext>;
  /** A session's recorded events from `after` onward: replay, then live while it runs. */
  readonly events: (
    sessionId: string,
    options?: { readonly after?: number },
  ) => Stream.Stream<SessionEvent, never, RuntimeContext>;
  /** Snapshot the container's filesystem now. */
  readonly snapshot: () => Effect.Effect<void, SessionError, RuntimeContext>;
  /** Snapshot the container, then stop it. */
  readonly stop: () => Effect.Effect<void, SessionError, RuntimeContext>;
}

const decodeInfo = Schema.decodeUnknownSync(SessionInfo);
const decodeStart = Schema.decodeUnknownSync(StartSession);

/** A snapshot taken this recently already covers a shutdown request. */
const RECENT_SNAPSHOT_MS = 5_000;

/**
 * A coding-agent harness in a container, kept working across restarts: its
 * sessions' history lives in this Durable Object, and the container's
 * filesystem is snapshotted when it shuts down and restored when it starts
 * again. Declare it at the top of the Durable Object that owns the
 * container; its program serves the harness (e.g. `{ fetch: claude.fetch }`).
 *
 * Snapshots need the container's `schedulingPolicy: "durable_object"`;
 * without it, history is still kept but the filesystem starts fresh.
 *
 * ### Running sessions that survive restarts
 * **Example:** A Durable Object with many sessions
 * ```typescript
 * export class Agent extends Cloudflare.DurableObject<Agent>()(
 *   "Agent",
 *   Effect.gen(function* () {
 *     const model = yield* Anthropic.Egress(Sandbox, {
 *       apiKey: Config.Redacted("ANTHROPIC_API_KEY"),
 *     });
 *     const harness = yield* Cloudflare.Containers.Harness(Sandbox);
 *
 *     return Effect.gen(function* () {
 *       const live = harness.start({ egress: [model] });
 *       return {
 *         open: () =>
 *           live.pipe(
 *             Effect.flatMap((claude) => claude.start({})),
 *             Effect.map((session) => session.id),
 *           ),
 *         prompt: (session: string, prompt: string) =>
 *           live.pipe(
 *             Effect.flatMap((claude) => claude.get(session)),
 *             Effect.flatMap((s) => s.prompt(prompt)),
 *           ),
 *         list: () => harness.list(),
 *         events: (session: string, after?: number) => harness.events(session, { after }),
 *         stop: () => harness.stop(),
 *       };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * @binding
 * @product Containers
 * @category Containers
 */
export const Harness = (
  container: Container.Decl.Any,
  options: HarnessOptions = {},
): Effect.Effect<Harness, never, DurableObjectState> =>
  Effect.gen(function* () {
    // Deploy: the container reports its SIGTERM to this object.
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const application = (yield* (
        container as unknown as { Application: Effect.Effect<ContainerApplication> }
      ).Application) as ContainerApplication;
      yield* application.bind`Harness`({ env: { [SNAPSHOT_ON_SHUTDOWN]: "1" } });
    }
    const sandbox =
      (yield* container as unknown as Effect.Effect<ContainerClient>) as ContainerClient;
    const state = yield* DurableObjectState;
    const port = options.port ?? 3000;

    //#region storage

    const sql = state.storage.sql;
    let ready = false;
    const ensureTables = Effect.suspend(() => {
      if (ready) return Effect.void;
      ready = true;
      return Effect.all([
        sql.exec(
          "CREATE TABLE IF NOT EXISTS alchemy_harness_sessions (id TEXT PRIMARY KEY, start TEXT NOT NULL, info TEXT, container_cursor INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
        ),
        sql.exec(
          "CREATE TABLE IF NOT EXISTS alchemy_harness_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        ),
      ]).pipe(Effect.asVoid);
    });
    const run = <A>(effect: Effect.Effect<A, never, RuntimeContext>) =>
      Effect.andThen(ensureTables, effect);

    const getMeta = (key: string) =>
      run(
        Effect.flatMap(
          sql.exec<{ value: string }>("SELECT value FROM alchemy_harness_meta WHERE key = ?", key),
          (cursor) => cursor.toArray(),
        ),
      ).pipe(Effect.map((rows) => rows[0]?.value));
    const setMeta = (key: string, value: string) =>
      run(
        sql
          .exec(
            "INSERT INTO alchemy_harness_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            key,
            value,
          )
          .pipe(Effect.asVoid),
      );

    type SessionRow = {
      id: string;
      start: string;
      info: string | null;
      container_cursor: number;
      generation: number;
    };
    const getSession = (id: string) =>
      run(
        Effect.flatMap(
          sql.exec<SessionRow>("SELECT * FROM alchemy_harness_sessions WHERE id = ?", id),
          (cursor) => cursor.toArray(),
        ),
      ).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));
    const recordSession = (id: string, start: StartSession) =>
      run(
        sql
          .exec(
            "INSERT INTO alchemy_harness_sessions (id, start, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING",
            id,
            JSON.stringify(start),
            Date.now(),
          )
          .pipe(Effect.asVoid),
      );
    const updateSession = (
      id: string,
      fields: {
        readonly info?: SessionInfo;
        readonly cursor?: number;
        readonly generation?: number;
      },
    ) =>
      run(
        Effect.all([
          fields.info === undefined
            ? Effect.void
            : sql.exec(
                "UPDATE alchemy_harness_sessions SET info = ? WHERE id = ?",
                JSON.stringify(fields.info),
                id,
              ),
          fields.cursor === undefined
            ? Effect.void
            : sql.exec(
                "UPDATE alchemy_harness_sessions SET container_cursor = ?, generation = ? WHERE id = ?",
                fields.cursor,
                fields.generation ?? 0,
                id,
              ),
        ]).pipe(Effect.asVoid),
      );

    // The event log: this Durable Object's SQLite, stamped with its own
    // cursors (a restarted container counts from 1 again).
    const store = yield* SessionStore.pipe(Effect.provide(DurableSessionStore));

    //#endregion

    //#region snapshots

    let lastSnapshotAt = 0;
    const snapshot = Effect.gen(function* () {
      const taken = yield* sandbox.snapshotContainer({ name: `harness-${Date.now()}` }).pipe(
        Effect.mapError(
          (cause) =>
            new SessionError({
              message: `snapshotting the container failed (snapshots need schedulingPolicy "durable_object"): ${cause.message}`,
            }),
        ),
      );
      lastSnapshotAt = Date.now();
      yield* setMeta(
        "snapshot",
        JSON.stringify({ id: taken.id, size: taken.size, at: lastSnapshotAt }),
      );
    });

    /** The container calls this when it is told to shut down. */
    const control = makeEgress({
      key: "alchemy:harness-control",
      hosts: [HARNESS_CONTROL_HOST],
      handle: (request) =>
        Effect.gen(function* () {
          if (new URL(request.url).pathname !== "/shutdown") {
            return new Response("not found\n", { status: 404 });
          }
          if (Date.now() - lastSnapshotAt < RECENT_SNAPSHOT_MS) return new Response("ok\n");
          const result = yield* Effect.exit(snapshot);
          if (Exit.isFailure(result)) {
            yield* Effect.logWarning("snapshot on shutdown failed", result.cause);
            return new Response("snapshot failed\n", { status: 500 });
          }
          return new Response("ok\n");
        }),
    });

    //#endregion

    //#region the running harness

    /** Each time the container starts, its sessions and cursors start over. */
    let generation = 0;
    /** The connection to this generation's harness, and what it mirrors. */
    let connection:
      | {
          readonly generation: number;
          readonly scope: Scope.Closeable;
          readonly harness: AIHarness;
          readonly mirrored: Set<string>;
        }
      | undefined;

    const startContainer = (startOptions: ContainerStartOptions | undefined) =>
      Effect.gen(function* () {
        const egress = [...(startOptions?.egress ?? []), control];
        if (yield* sandbox.running.pipe(Effect.orElseSucceed(() => false))) {
          // Running: only the egress may have changed.
          yield* sandbox.start({ ...startOptions, egress });
          if (generation === 0) {
            // A new activation of this object found the container running.
            generation = Number((yield* getMeta("generation")) ?? "1");
          }
          return;
        }
        generation = Number((yield* getMeta("generation")) ?? "0") + 1;
        yield* setMeta("generation", String(generation));
        const latest = yield* getMeta("snapshot");
        const restore = latest ? (JSON.parse(latest) as { id: string }) : undefined;
        if (restore) {
          const restored = yield* Effect.exit(
            sandbox.start({
              ...startOptions,
              egress,
              containerSnapshot: { id: restore.id },
            } as ContainerStartOptions),
          );
          if (Exit.isSuccess(restored)) return;
          yield* Effect.logWarning(
            "restoring the container's snapshot failed; starting fresh",
            restored.cause,
          );
        }
        // TODO(harness-recovery): the container is starting without its latest
        // state — there was no snapshot (it crashed, or never shut down
        // cleanly), or restoring it failed. Sessions resume from whatever is
        // on disk (nothing, here), so their agents have lost their workspace
        // and possibly their conversation. Detect this per session (it has
        // recorded events past the snapshot) and inject a message telling
        // the agent what happened, so it can recover (re-clone, re-read the
        // history in its context, redo uncommitted work).
        yield* sandbox.start({ ...startOptions, egress });
      }).pipe(
        Effect.mapError(
          (cause) =>
            new SessionError({ message: `starting the container failed: ${String(cause)}` }),
        ),
      );

    const connect = Effect.gen(function* () {
      if (connection && connection.generation === generation) return connection;
      if (connection) yield* Scope.close(connection.scope, Exit.void);
      const scope = yield* Scope.make();
      const tcp = yield* sandbox.getTcpPort(port);
      const harness = yield* connectHarness(toHttpClient(tcp as never)).pipe(Scope.provide(scope));
      connection = { generation, scope, harness, mirrored: new Set() };
      return connection;
    });

    /** Copy a session's events from the container into this object, in the background. */
    const mirror = (current: NonNullable<typeof connection>, session: Session) =>
      Effect.gen(function* () {
        if (current.mirrored.has(session.id)) return;
        current.mirrored.add(session.id);
        const row = yield* getSession(session.id);
        const after = Option.match(row, {
          onNone: () => 0,
          // A new container's cursors start over.
          onSome: (r) => (r.generation === current.generation ? r.container_cursor : 0),
        });
        yield* session.events({ after }).pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              const { cursor, sessionId: _sessionId, at: _at, ...input } = event;
              yield* store.append(session.id, input as SessionEventInput);
              yield* updateSession(session.id, { cursor, generation: current.generation });
              if (
                event.type === "state" ||
                event.type === "turn.completed" ||
                event.type === "model.changed"
              ) {
                const info = yield* session.info().pipe(Effect.option);
                if (Option.isSome(info)) yield* updateSession(session.id, { info: info.value });
              }
            }),
          ),
          Effect.ignore,
          Effect.ensuring(Effect.sync(() => current.mirrored.delete(session.id))),
          Effect.forkIn(current.scope),
        );
      });

    /** The container's session, wrapped so its history is read from this object. */
    const durableSession = (session: Session): Session => ({
      ...session,
      events: (eventsOptions) => store.read(session.id, eventsOptions),
    });

    const durableHarness = (current: NonNullable<typeof connection>): AIHarness => ({
      name: current.harness.name,
      capabilities: current.harness.capabilities,
      start: (startOptions) =>
        Effect.gen(function* () {
          const id = startOptions?.id ?? crypto.randomUUID();
          const open = { ...startOptions, id };
          yield* recordSession(id, { ...open, prompt: undefined });
          const session = yield* current.harness.start(open);
          yield* mirror(current, session);
          return durableSession(session);
        }),
      get: (id) =>
        Effect.gen(function* () {
          const existing = yield* current.harness.get(id).pipe(Effect.option);
          if (Option.isSome(existing)) {
            yield* mirror(current, existing.value);
            return durableSession(existing.value);
          }
          // Not in this container (it restarted): reopen it from its record —
          // the harness resumes it from the files on disk.
          const row = yield* getSession(id);
          if (Option.isNone(row)) {
            return yield* new SessionError({ sessionId: id, message: `no session ${id}` });
          }
          const session = yield* current.harness.start({
            ...decodeStart(JSON.parse(row.value.start)),
            id,
          });
          yield* mirror(current, session);
          return durableSession(session);
        }),
      list: () => list(),
    });

    //#endregion

    const list = () =>
      run(
        Effect.flatMap(
          sql.exec<{ id: string; info: string | null }>(
            "SELECT id, info FROM alchemy_harness_sessions ORDER BY created_at DESC",
          ),
          (cursor) => cursor.toArray(),
        ),
      ).pipe(
        Effect.map((rows) =>
          rows.flatMap((row) => (row.info ? [decodeInfo(JSON.parse(row.info))] : [])),
        ),
      );

    return {
      start: (startOptions) =>
        startContainer(startOptions).pipe(
          Effect.andThen(connect),
          Effect.map(durableHarness),
          Effect.mapError((cause) =>
            cause instanceof SessionError
              ? cause
              : new SessionError({ message: `connecting to the harness failed: ${String(cause)}` }),
          ),
        ),
      list,
      events: (sessionId, eventsOptions) => store.read(sessionId, eventsOptions),
      snapshot: () => snapshot,
      stop: () =>
        Effect.gen(function* () {
          const taken = yield* Effect.exit(snapshot);
          if (Exit.isFailure(taken)) {
            yield* Effect.logWarning("snapshot before stopping failed", taken.cause);
          }
          if (connection) {
            yield* Scope.close(connection.scope, Exit.void);
            connection = undefined;
          }
          yield* sandbox.destroy().pipe(Effect.ignore);
        }),
    } satisfies Harness;
  });
