import * as Cloudflare from "alchemy/Cloudflare";
import type { MainRpc } from "alchemy/Platform";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { inWorker } from "../platform/Database.ts";

/**
 * The BOARD — one Durable Object instance per queue (`idFromName` on
 * the queue's slug) holding the queue's tasks and their GitHub-style
 * timeline. TriageDO's shape grown into a board: one SQLite database,
 * one single-threaded turn per verb — the turn IS the lock, so a
 * claim can never race a claim.
 *
 * The task's CONVERSATION is not here: it is a Posts thread (a root
 * post in the `tasks:<queue>` channel — ChatDO); `root_post` points
 * at it. The board holds only the typed lifecycle: states, desks,
 * events.
 */

export type TaskState =
  | "inbox"
  | "ready"
  | "working"
  | "review"
  | "parked"
  | "done"
  | "dropped";

/**
 * The legal state machine, PURE — the one place a hop is allowed or
 * refused. `done` and `dropped` are terminal: reopening is filing a
 * new task, never resurrecting a closed one.
 */
const TRANSITIONS: Record<TaskState, ReadonlyArray<TaskState>> = {
  // routed out by the router (or dropped by a human)
  inbox: ["ready", "dropped"],
  // claimed by a desk; a human may re-route or park it
  ready: ["working", "inbox", "parked", "dropped"],
  // the desk's dispositions: review, park, handoff (→ inbox/ready)
  working: ["review", "ready", "parked", "done", "inbox", "dropped"],
  // the review gate claims it (→ working) or a human overrides
  review: ["working", "ready", "done", "parked", "dropped"],
  parked: ["ready", "inbox", "dropped"],
  done: [],
  dropped: [],
};

export const transition = (current: TaskState, next: TaskState): boolean =>
  current !== next && (TRANSITIONS[current] ?? []).includes(next);

export const TASK_STATES: ReadonlyArray<TaskState> = [
  "inbox",
  "ready",
  "working",
  "review",
  "parked",
  "done",
  "dropped",
];

export const isTaskState = (value: string): value is TaskState =>
  (TASK_STATES as ReadonlyArray<string>).includes(value);

/** The default event kind a hop into `next` records — callers pass an
 *  explicit kind when the timeline knows better (`changes_requested`,
 *  `approved`). */
export const eventKindOf = (next: TaskState): string =>
  ({
    inbox: "routed",
    ready: "routed",
    working: "started",
    review: "review_requested",
    parked: "parked",
    done: "done",
    dropped: "dropped",
  })[next];

export interface TaskRow {
  readonly id: string;
  readonly queue: string;
  readonly title: string;
  readonly body: string;
  readonly state: TaskState;
  /** The task's AREA tags (Tags.ts) — tags[0] is the router's pick. */
  readonly tags: ReadonlyArray<string>;
  /** The member slug working/last working it (`engineer`). */
  readonly desk?: string;
  /** The task's thread root in ChatDO (`tasks:<queue>` channel). */
  readonly rootPost?: string;
  /** Where it came from: `github:org/alchemy#1521` | `post:p-…` | `human`. */
  readonly origin?: string;
  readonly priority: number;
  readonly parkedReason?: string;
  readonly at: number;
  readonly updated: number;
}

export interface TaskEventRow {
  readonly id: number;
  readonly task: string;
  /** routed|assigned|started|posted|parked|review_requested|
   *  changes_requested|approved|done|dropped|filed|tagged */
  readonly kind: string;
  readonly actor: string;
  /** JSON payload (post id, session key, verdict, reason…). */
  readonly data?: string;
  readonly at: number;
}

/** What a desk looks like from the outside: its working task and the
 *  recent tasks it touched (title + tags) — the scheduler's affinity
 *  signal. */
export interface DeskView {
  readonly working?: TaskRow;
  readonly recent: ReadonlyArray<{
    readonly title: string;
    readonly tags: ReadonlyArray<string>;
  }>;
}

/** Mint a task id the way Posts mints post ids — never `Date.now()`
 *  in a name; the clock rides the Effect runtime. */
export const mintTaskId: Effect.Effect<string> = Effect.map(
  Clock.currentTimeMillis,
  (millis) =>
    `t-${millis.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
);

/** Dispatches one queue may spend per hour (Desks.ts's budget). */
export const DISPATCHES_PER_HOUR = 20;

const TABLES = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    queue TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    state TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    desk TEXT,
    root_post TEXT,
    origin TEXT,
    priority INTEGER NOT NULL DEFAULT 2,
    parked_reason TEXT,
    at INTEGER NOT NULL,
    updated INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS tasks_state ON tasks (state)`,
  `CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task TEXT NOT NULL,
    kind TEXT NOT NULL,
    actor TEXT NOT NULL,
    data TEXT,
    at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS task_events_task ON task_events (task)`,
  `CREATE TABLE IF NOT EXISTS dispatch_spend (
    bucket INTEGER PRIMARY KEY,
    n INTEGER NOT NULL
  )`,
];

interface TaskDbRow extends Record<string, Cloudflare.SqlStorageValue> {
  id: string;
  queue: string;
  title: string;
  body: string;
  state: string;
  tags: string;
  desk: string | null;
  root_post: string | null;
  origin: string | null;
  priority: number;
  parked_reason: string | null;
  at: number;
  updated: number;
}

interface EventDbRow extends Record<string, Cloudflare.SqlStorageValue> {
  id: number;
  task: string;
  kind: string;
  actor: string;
  data: string | null;
  at: number;
}

/** The tags column, parsed defensively — a bad row reads as none. */
const tagsOf = (raw: string): ReadonlyArray<string> => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

const toTask = (row: TaskDbRow): TaskRow => ({
  id: row.id,
  queue: row.queue,
  title: row.title,
  body: row.body,
  state: row.state as TaskState,
  tags: tagsOf(row.tags),
  ...(row.desk === null ? {} : { desk: row.desk }),
  ...(row.root_post === null ? {} : { rootPost: row.root_post }),
  ...(row.origin === null ? {} : { origin: row.origin }),
  priority: row.priority,
  ...(row.parked_reason === null ? {} : { parkedReason: row.parked_reason }),
  at: row.at,
  updated: row.updated,
});

const toEvent = (row: EventDbRow): TaskEventRow => ({
  id: row.id,
  task: row.task,
  kind: row.kind,
  actor: row.actor,
  ...(row.data === null ? {} : { data: row.data }),
  at: row.at,
});

export interface FileInput {
  readonly id: string;
  readonly queue: string;
  readonly title: string;
  readonly body: string;
  /** `inbox` when routing was unsure (a human routes), `ready` when
   *  the router (or the human) already placed it. */
  readonly state: "inbox" | "ready";
  /** The area tags — tags[0] is the router's pick; empty when the
   *  router was unsure. */
  readonly tags?: ReadonlyArray<string>;
  readonly origin?: string;
  readonly priority?: number;
  readonly rootPost?: string;
  readonly actor: string;
}

export interface RouteInput {
  readonly state: TaskState;
  readonly desk?: string;
  readonly actor: string;
  /** Timeline kind override (`changes_requested`, `approved`). */
  readonly kind?: string;
  readonly data?: string;
}

interface TasksRpc extends MainRpc<Cloudflare.DurableObjectState> {
  readonly file: (
    input: FileInput,
  ) => Effect.Effect<TaskRow, never, RuntimeContext>;
  readonly route: (
    id: string,
    input: RouteInput,
  ) => Effect.Effect<TaskRow | undefined, never, RuntimeContext>;
  readonly retag: (
    id: string,
    tags: ReadonlyArray<string>,
    actor: string,
  ) => Effect.Effect<TaskRow | undefined, never, RuntimeContext>;
  readonly list: (
    state?: TaskState,
  ) => Effect.Effect<ReadonlyArray<TaskRow>, never, RuntimeContext>;
  readonly get: (
    id: string,
  ) => Effect.Effect<TaskRow | undefined, never, RuntimeContext>;
  readonly events: (
    id: string,
  ) => Effect.Effect<ReadonlyArray<TaskEventRow>, never, RuntimeContext>;
  readonly claimNext: (
    desk: string,
    options?: { readonly from?: "ready" | "review"; readonly preferred?: string },
  ) => Effect.Effect<TaskRow | undefined, never, RuntimeContext>;
  readonly deskState: (
    desk: string,
  ) => Effect.Effect<DeskView, never, RuntimeContext>;
  readonly comment: (
    id: string,
    actor: string,
    post: string,
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly spendDispatch: () => Effect.Effect<
    boolean,
    never,
    RuntimeContext
  >;
}

const TasksDOLive = Cloudflare.DurableObject<TasksRpc>()(
  "TasksDO",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const sql = state.storage.sql;

    return Effect.gen(function* () {
      yield* Effect.forEach(
        TABLES,
        (table) =>
          sql.exec(table.trim().replaceAll(/\s+/g, " ")).pipe(Effect.asVoid),
        { discard: true },
      );

      const taskOf = Effect.fn(function* (id: string) {
        const rows = yield* (yield* sql.exec<TaskDbRow>(
          "SELECT * FROM tasks WHERE id = ?",
          id,
        )).toArray();
        return rows[0] === undefined ? undefined : toTask(rows[0]);
      });

      const event = Effect.fn(function* (
        task: string,
        kind: string,
        actor: string,
        data?: string,
      ) {
        const at = yield* Clock.currentTimeMillis;
        yield* sql.exec(
          "INSERT INTO task_events (task, kind, actor, data, at) VALUES (?, ?, ?, ?, ?)",
          task,
          kind,
          actor,
          data ?? null,
          at,
        );
      });

      const move = Effect.fn(function* (
        task: TaskRow,
        input: RouteInput,
      ) {
        const at = yield* Clock.currentTimeMillis;
        yield* sql.exec(
          "UPDATE tasks SET state = ?, desk = ?, parked_reason = ?, updated = ? WHERE id = ?",
          input.state,
          input.desk ?? (input.state === "inbox" ? null : (task.desk ?? null)),
          input.state === "parked" ? (input.data ?? null) : null,
          at,
          task.id,
        );
        yield* event(
          task.id,
          input.kind ?? eventKindOf(input.state),
          input.actor,
          input.data,
        );
        return yield* taskOf(task.id);
      });

      return {
        file: Effect.fn(function* (input) {
          const at = yield* Clock.currentTimeMillis;
          yield* sql.exec(
            "INSERT INTO tasks (id, queue, title, body, state, tags, root_post, origin, priority, at, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            input.id,
            input.queue,
            input.title,
            input.body,
            input.state,
            JSON.stringify(input.tags ?? []),
            input.rootPost ?? null,
            input.origin ?? null,
            input.priority ?? 2,
            at,
            at,
          );
          yield* event(
            input.id,
            "filed",
            input.actor,
            JSON.stringify({ state: input.state, tags: input.tags ?? [] }),
          );
          return (yield* taskOf(input.id))!;
        }),

        route: Effect.fn(function* (id, input) {
          const task = yield* taskOf(id);
          if (task === undefined) return undefined;
          if (!transition(task.state, input.state)) return undefined;
          return yield* move(task, input);
        }),

        // retag is not a state hop — the tags column and a `tagged`
        // timeline event, nothing else moves
        retag: Effect.fn(function* (id, tags, actor) {
          const task = yield* taskOf(id);
          if (task === undefined) return undefined;
          const at = yield* Clock.currentTimeMillis;
          yield* sql.exec(
            "UPDATE tasks SET tags = ?, updated = ? WHERE id = ?",
            JSON.stringify(tags),
            at,
            id,
          );
          yield* event(id, "tagged", actor, JSON.stringify({ tags }));
          return yield* taskOf(id);
        }),

        list: Effect.fn(function* (state?: TaskState) {
          const rows = yield* (yield* (state === undefined
            ? sql.exec<TaskDbRow>("SELECT * FROM tasks ORDER BY at")
            : sql.exec<TaskDbRow>(
                "SELECT * FROM tasks WHERE state = ? ORDER BY priority, at",
                state,
              ))).toArray();
          return rows.map(toTask);
        }),

        get: Effect.fn(function* (id) {
          return yield* taskOf(id);
        }),

        events: Effect.fn(function* (id) {
          const rows = yield* (yield* sql.exec<EventDbRow>(
            "SELECT * FROM task_events WHERE task = ? ORDER BY id",
            id,
          )).toArray();
          return rows.map(toEvent);
        }),

        // ATOMIC claim: the DO turn is the lock. A busy desk claims
        // nothing; the scheduler's preference is advisory — taken
        // only if the task is still in the source state.
        claimNext: Effect.fn(function* (desk, options) {
          const from = options?.from ?? "ready";
          const busy = yield* (yield* sql.exec<TaskDbRow>(
            "SELECT * FROM tasks WHERE state = 'working' AND desk = ? LIMIT 1",
            desk,
          )).toArray();
          if (busy.length > 0) return undefined;
          let chosen: TaskRow | undefined;
          if (options?.preferred !== undefined) {
            const preferred = yield* taskOf(options.preferred);
            if (preferred !== undefined && preferred.state === from) {
              chosen = preferred;
            }
          }
          if (chosen === undefined) {
            const rows = yield* (yield* sql.exec<TaskDbRow>(
              "SELECT * FROM tasks WHERE state = ? ORDER BY priority, at LIMIT 1",
              from,
            )).toArray();
            chosen = rows[0] === undefined ? undefined : toTask(rows[0]);
          }
          if (chosen === undefined) return undefined;
          yield* event(
            chosen.id,
            "assigned",
            "scheduler",
            JSON.stringify({ desk }),
          );
          return yield* move(chosen, {
            state: "working",
            desk,
            actor: desk,
            kind: "started",
          });
        }),

        deskState: Effect.fn(function* (desk) {
          const working = yield* (yield* sql.exec<TaskDbRow>(
            "SELECT * FROM tasks WHERE state = 'working' AND desk = ? LIMIT 1",
            desk,
          )).toArray();
          const recent = yield* (yield* sql.exec<TaskDbRow>(
            "SELECT * FROM tasks WHERE desk = ? AND state != 'working' ORDER BY updated DESC LIMIT 5",
            desk,
          )).toArray();
          return {
            ...(working[0] === undefined
              ? {}
              : { working: toTask(working[0]) }),
            recent: recent.map((row) => ({
              title: row.title,
              tags: tagsOf(row.tags),
            })),
          };
        }),

        comment: Effect.fn(function* (id, actor, post) {
          yield* event(id, "posted", actor, JSON.stringify({ post }));
        }),

        // the per-queue dispatch budget: an hour-bucket counter — a
        // spend over the cap answers false and the desk loop rests
        spendDispatch: Effect.fn(function* () {
          const at = yield* Clock.currentTimeMillis;
          const bucket = Math.floor(at / 3_600_000);
          const rows = yield* (yield* sql.exec<
            { n: number } & Record<string, Cloudflare.SqlStorageValue>
          >("SELECT n FROM dispatch_spend WHERE bucket = ?", bucket)).toArray();
          const spent = rows[0]?.n ?? 0;
          if (spent >= DISPATCHES_PER_HOUR) return false;
          yield* sql.exec(
            "INSERT INTO dispatch_spend (bucket, n) VALUES (?, 1) ON CONFLICT (bucket) DO UPDATE SET n = n + 1",
            bucket,
          );
          return true;
        }),
      } satisfies TasksRpc;
    });
  }),
);

/**
 * The BOARD's facade — every verb takes the queue's slug first and
 * lands on that queue's own DO instance. The verb surface the desk
 * loop (Desks.ts), the API (TasksApi.ts), and intake (Triage) share.
 */
export class Tasks extends Context.Service<
  Tasks,
  {
    readonly file: (queue: string, input: FileInput) => Effect.Effect<TaskRow>;
    readonly route: (
      queue: string,
      id: string,
      input: RouteInput,
    ) => Effect.Effect<TaskRow | undefined>;
    readonly retag: (
      queue: string,
      id: string,
      tags: ReadonlyArray<string>,
      actor: string,
    ) => Effect.Effect<TaskRow | undefined>;
    readonly list: (
      queue: string,
      state?: TaskState,
    ) => Effect.Effect<ReadonlyArray<TaskRow>>;
    readonly get: (
      queue: string,
      id: string,
    ) => Effect.Effect<TaskRow | undefined>;
    readonly events: (
      queue: string,
      id: string,
    ) => Effect.Effect<ReadonlyArray<TaskEventRow>>;
    readonly claimNext: (
      queue: string,
      desk: string,
      options?: {
        readonly from?: "ready" | "review";
        readonly preferred?: string;
      },
    ) => Effect.Effect<TaskRow | undefined>;
    readonly deskState: (
      queue: string,
      desk: string,
    ) => Effect.Effect<DeskView>;
    readonly comment: (
      queue: string,
      id: string,
      actor: string,
      post: string,
    ) => Effect.Effect<void>;
    readonly spendDispatch: (queue: string) => Effect.Effect<boolean>;
  }
>()("root/Tasks") {}

/** The {@link Tasks} facade over one TasksDO instance per queue. */
export const TasksLive: Layer.Layer<Tasks, never, Cloudflare.Worker> =
  Layer.effect(
    Tasks,
    Effect.gen(function* () {
      const namespace = yield* TasksDOLive;
      const stub = (queue: string) => namespace.getByName(queue);
      return Tasks.of({
        file: (queue, input) => inWorker(stub(queue).file(input)),
        route: (queue, id, input) => inWorker(stub(queue).route(id, input)),
        retag: (queue, id, tags, actor) =>
          inWorker(stub(queue).retag(id, tags, actor)),
        list: (queue, state) => inWorker(stub(queue).list(state)),
        get: (queue, id) => inWorker(stub(queue).get(id)),
        events: (queue, id) => inWorker(stub(queue).events(id)),
        claimNext: (queue, desk, options) =>
          inWorker(stub(queue).claimNext(desk, options)),
        deskState: (queue, desk) => inWorker(stub(queue).deskState(desk)),
        comment: (queue, id, actor, post) =>
          inWorker(stub(queue).comment(id, actor, post)),
        spendDispatch: (queue) => inWorker(stub(queue).spendDispatch()),
      });
    }),
  );
