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
  /** Every desk that ever WORKED the task — stamped on claim, never
   *  cleared. The affinity signal reads THIS, not `desk`: a completed
   *  task's `desk` flips to the reviewer, which starved the
   *  engineer's `recent` of its own finished work. */
  readonly workedBy: ReadonlyArray<string>;
  /** The human's drag position among READY siblings — a sparse
   *  fractional key sharing one axis with age ({@link HINT_NULL_OFFSET}),
   *  so ONE drag writes ONE row. Null = never dragged (sorts last,
   *  by age). A SUGGESTION to the scheduler, never a hard order. */
  readonly hint?: number;
  /** The scheduler's materialized rank among ready siblings (1 =
   *  claim next). Written by re-ranks (arrival/settle/reorder/retag),
   *  consumed by claims — ZERO judging on the claim path. */
  readonly rank?: number;
  /** One line of why the rank is what it is — `sam's order`,
   *  `follows t-4f2 (same cloudflare)`, `urgent (82%)`; a `judge:`
   *  prefix marks a rank that went AGAINST the human's dragged
   *  order (the transparency is the feature). */
  readonly rankWhy?: string;
  /** The SESSION key the working round dispatched into — the trunk
   *  desk key, or a clone (`<deskKey>#<n>`) when the desk's width
   *  forked one. Recovery reads THIS session's log. */
  readonly session?: string;
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
   *  changes_requested|approved|done|dropped|filed|tagged|reordered */
  readonly kind: string;
  readonly actor: string;
  /** JSON payload (post id, session key, verdict, reason…). */
  readonly data?: string;
  readonly at: number;
}

/** What a desk looks like from the outside: its working tasks, its
 *  width, and the recent tasks it touched (title + tags) — the
 *  scheduler's affinity signal. */
export interface DeskView {
  /** The tasks the desk is working right now, oldest claim first —
   *  width 1 (the linear default) keeps this a 0/1-element list. */
  readonly working: ReadonlyArray<TaskRow>;
  /** How many tasks the desk may work at once (1..{@link MAX_DESK_WIDTH})
   *  — width 1 is linear; >1 forks clone sessions (Desks.ts). */
  readonly width: number;
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

/** The desk-width ceiling — parallelism stays an explicit, bounded
 *  exception to the linear desk (`setWidth` clamps into 1..this). */
export const MAX_DESK_WIDTH = 4;

/** An undragged task's key on the hint axis is its age pushed past
 *  any explicit hint — hints and ages share ONE numeric axis, so a
 *  drag between two undragged cards still writes ONE fractional key
 *  (nulls last, by age; `at` is epoch millis ≈ 1.8e12 ≪ 1e15). */
export const HINT_NULL_OFFSET = 1_000_000_000_000_000;

/** The spacing a drag past the edge of the list leaves for the next
 *  drag — sparse fractional indexing's gap. */
export const HINT_GAP = 1_024;

/** Ready order: judged rank first (nulls last), then the human's
 *  hint axis (nulls last by age) — the claim path and the board's
 *  ready column read the SAME order. */
const READY_ORDER = `(rank IS NULL), rank, COALESCE(hint, at + ${HINT_NULL_OFFSET}), at`;

const TABLES = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    queue TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    state TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    desk TEXT,
    session TEXT,
    root_post TEXT,
    origin TEXT,
    priority INTEGER NOT NULL DEFAULT 2,
    parked_reason TEXT,
    worked_by TEXT NOT NULL DEFAULT '[]',
    hint REAL,
    rank INTEGER,
    rank_why TEXT,
    at INTEGER NOT NULL,
    updated INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS tasks_state ON tasks (state)`,
  `CREATE TABLE IF NOT EXISTS task_scores (
    id TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    urgency REAL NOT NULL,
    fit_json TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
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
  `CREATE TABLE IF NOT EXISTS desk_settings (
    desk TEXT PRIMARY KEY,
    width INTEGER NOT NULL DEFAULT 1
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
  session: string | null;
  root_post: string | null;
  origin: string | null;
  priority: number;
  parked_reason: string | null;
  worked_by: string;
  hint: number | null;
  rank: number | null;
  rank_why: string | null;
  at: number;
  updated: number;
}

interface ScoreDbRow extends Record<string, Cloudflare.SqlStorageValue> {
  id: string;
  hash: string;
  urgency: number;
  fit_json: string;
  at: number;
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
  ...(row.session === null ? {} : { session: row.session }),
  ...(row.root_post === null ? {} : { rootPost: row.root_post }),
  ...(row.origin === null ? {} : { origin: row.origin }),
  priority: row.priority,
  ...(row.parked_reason === null ? {} : { parkedReason: row.parked_reason }),
  workedBy: tagsOf(row.worked_by ?? "[]"),
  ...(row.hint === null ? {} : { hint: row.hint }),
  ...(row.rank === null ? {} : { rank: row.rank }),
  ...(row.rank_why === null ? {} : { rankWhy: row.rank_why }),
  at: row.at,
  updated: row.updated,
});

/** A `fit_json` column parsed defensively — a bad row reads empty. */
const fitOf = (raw: string): Record<string, number> => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).filter(
            (entry): entry is [string, number] => typeof entry[1] === "number",
          ),
        )
      : {};
  } catch {
    return {};
  }
};

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

/** One drag on the board: place the task before/after a READY
 *  sibling, or at an absolute index. Exactly one anchor applies —
 *  `before` wins over `after` wins over `position`. */
export interface ReorderInput {
  readonly before?: string;
  readonly after?: string;
  readonly position?: number;
  readonly actor: string;
}

/** One task's cached MAP scores (Scheduler.ts): keyed by a content
 *  hash so unchanged tasks are never re-judged; `fit` is per desk. */
export interface TaskScoreRow {
  readonly id: string;
  readonly hash: string;
  readonly urgency: number;
  readonly fit: Record<string, number>;
  readonly at: number;
}

/** One materialized rank row a re-rank writes back to the board. */
export interface RankWrite {
  readonly id: string;
  readonly rank: number;
  readonly rankWhy: string;
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
  readonly reorder: (
    id: string,
    input: ReorderInput,
  ) => Effect.Effect<TaskRow | undefined, never, RuntimeContext>;
  readonly scores: () => Effect.Effect<
    ReadonlyArray<TaskScoreRow>,
    never,
    RuntimeContext
  >;
  readonly writeScore: (
    id: string,
    hash: string,
    urgency: number,
    fit: Record<string, number>,
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly writeRanks: (
    entries: ReadonlyArray<RankWrite>,
  ) => Effect.Effect<void, never, RuntimeContext>;
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
    options?: {
      readonly from?: "ready" | "review";
      readonly preferred?: string;
      /** The session key the claim's round will dispatch into —
       *  recorded on the task row (recovery reads it). */
      readonly session?: string;
    },
  ) => Effect.Effect<TaskRow | undefined, never, RuntimeContext>;
  readonly deskState: (
    desk: string,
  ) => Effect.Effect<DeskView, never, RuntimeContext>;
  readonly setWidth: (
    desk: string,
    width: number,
  ) => Effect.Effect<number, never, RuntimeContext>;
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
      // tasks written under earlier schemas — PRAGMA-guarded so a
      // re-run never throws duplicate-column and poisons the DO
      const columns = yield* (yield* sql.exec<
        { name: string } & Record<string, Cloudflare.SqlStorageValue>
      >("SELECT name FROM pragma_table_info('tasks')")).toArray();
      if (!columns.some((column) => column.name === "session")) {
        yield* sql.exec("ALTER TABLE tasks ADD COLUMN session TEXT");
      }
      if (!columns.some((column) => column.name === "worked_by")) {
        yield* sql.exec(
          "ALTER TABLE tasks ADD COLUMN worked_by TEXT NOT NULL DEFAULT '[]'",
        );
        yield* sql.exec("ALTER TABLE tasks ADD COLUMN hint REAL");
        yield* sql.exec("ALTER TABLE tasks ADD COLUMN rank INTEGER");
        yield* sql.exec("ALTER TABLE tasks ADD COLUMN rank_why TEXT");
        // seed the worked-by memory from history: any desk a task's
        // `assigned` events name has worked it (the claim events ARE
        // the memory for rows written under earlier schemas)
        const assigned = yield* (yield* sql.exec<EventDbRow>(
          "SELECT * FROM task_events WHERE kind = 'assigned'",
        )).toArray();
        const workedBy = new Map<string, Set<string>>();
        for (const row of assigned) {
          try {
            const desk = (JSON.parse(row.data ?? "{}") as { desk?: string })
              .desk;
            if (typeof desk === "string" && desk.length > 0) {
              (workedBy.get(row.task) ??
                workedBy.set(row.task, new Set()).get(row.task)!).add(desk);
            }
          } catch {
            // an unparsable assigned payload seeds nothing
          }
        }
        yield* Effect.forEach(
          workedBy,
          ([task, desks]) =>
            sql
              .exec(
                "UPDATE tasks SET worked_by = ? WHERE id = ?",
                JSON.stringify([...desks]),
                task,
              )
              .pipe(Effect.asVoid),
          { discard: true },
        );
      }

      /** The desk's width (1 unless dialed up — `setWidth`). */
      const widthOf = Effect.fn(function* (desk: string) {
        const rows = yield* (yield* sql.exec<
          { width: number } & Record<string, Cloudflare.SqlStorageValue>
        >("SELECT width FROM desk_settings WHERE desk = ?", desk)).toArray();
        return rows[0]?.width ?? 1;
      });

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

        // the human's DRAG — one row written: a fractional key on
        // the shared hint/age axis between the anchor's neighbors.
        // A drag also invalidates the judged order (ranks cleared):
        // the hint axis rules until the next re-rank lands, so the
        // board never snaps back to a stale judgment.
        reorder: Effect.fn(function* (id, input) {
          const task = yield* taskOf(id);
          if (task === undefined || task.state !== "ready") return undefined;
          const siblings = yield* (yield* sql.exec<TaskDbRow>(
            `SELECT * FROM tasks WHERE state = 'ready' AND id != ? ORDER BY COALESCE(hint, at + ${HINT_NULL_OFFSET}), at`,
            id,
          )).toArray();
          const keys = siblings.map(
            (row) => row.hint ?? row.at + HINT_NULL_OFFSET,
          );
          let index: number;
          if (input.before !== undefined) {
            index = siblings.findIndex((row) => row.id === input.before);
            if (index < 0) return undefined;
          } else if (input.after !== undefined) {
            const anchor = siblings.findIndex((row) => row.id === input.after);
            if (anchor < 0) return undefined;
            index = anchor + 1;
          } else {
            index = Math.min(
              siblings.length,
              Math.max(0, Math.round(input.position ?? siblings.length)),
            );
          }
          const prev = keys[index - 1];
          const next = keys[index];
          const hint =
            prev !== undefined && next !== undefined
              ? (prev + next) / 2
              : prev !== undefined
                ? prev + HINT_GAP
                : next !== undefined
                  ? next - HINT_GAP
                  : 0;
          const at = yield* Clock.currentTimeMillis;
          yield* sql.exec(
            "UPDATE tasks SET hint = ?, updated = ? WHERE id = ?",
            hint,
            at,
            id,
          );
          yield* sql.exec(
            "UPDATE tasks SET rank = NULL, rank_why = NULL WHERE state = 'ready'",
          );
          yield* event(
            id,
            "reordered",
            input.actor,
            JSON.stringify({
              hint,
              ...(input.before === undefined ? {} : { before: input.before }),
              ...(input.after === undefined ? {} : { after: input.after }),
              ...(input.position === undefined
                ? {}
                : { position: input.position }),
            }),
          );
          return yield* taskOf(id);
        }),

        // the MAP cache — one row per task, keyed by content hash so
        // an unchanged task never burns a judge call
        scores: Effect.fn(function* () {
          const rows = yield* (yield* sql.exec<ScoreDbRow>(
            "SELECT * FROM task_scores",
          )).toArray();
          return rows.map((row) => ({
            id: row.id,
            hash: row.hash,
            urgency: row.urgency,
            fit: fitOf(row.fit_json),
            at: row.at,
          }));
        }),

        writeScore: Effect.fn(function* (id, hash, urgency, fit) {
          const at = yield* Clock.currentTimeMillis;
          yield* sql.exec(
            "INSERT INTO task_scores (id, hash, urgency, fit_json, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET hash = ?, urgency = ?, fit_json = ?, at = ?",
            id,
            hash,
            urgency,
            JSON.stringify(fit),
            at,
            hash,
            urgency,
            JSON.stringify(fit),
            at,
          );
        }),

        // materialize one re-rank: every ready row's rank is rewritten
        // (stale ranks cleared), the score cache pruned to ready ids.
        // `updated` is deliberately untouched — a re-rank is not work.
        writeRanks: Effect.fn(function* (entries) {
          yield* sql.exec(
            "UPDATE tasks SET rank = NULL, rank_why = NULL WHERE state = 'ready'",
          );
          yield* Effect.forEach(
            entries,
            (entry) =>
              sql
                .exec(
                  "UPDATE tasks SET rank = ?, rank_why = ? WHERE id = ? AND state = 'ready'",
                  entry.rank,
                  entry.rankWhy,
                  entry.id,
                )
                .pipe(Effect.asVoid),
            { discard: true },
          );
          yield* sql.exec(
            "DELETE FROM task_scores WHERE id NOT IN (SELECT id FROM tasks WHERE state = 'ready')",
          );
        }),

        list: Effect.fn(function* (state?: TaskState) {
          const rows = yield* (yield* (state === undefined
            ? sql.exec<TaskDbRow>("SELECT * FROM tasks ORDER BY at")
            : state === "ready"
              ? sql.exec<TaskDbRow>(
                  `SELECT * FROM tasks WHERE state = 'ready' ORDER BY ${READY_ORDER}`,
                )
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

        // ATOMIC claim: the DO turn is the lock. A desk at its width
        // claims nothing; the scheduler's preference is advisory —
        // taken only if the task is still in the source state. The
        // caller's session key (trunk or clone) rides the claim so
        // recovery knows which session's log to read.
        claimNext: Effect.fn(function* (desk, options) {
          const from = options?.from ?? "ready";
          const busy = yield* (yield* sql.exec<
            { n: number } & Record<string, Cloudflare.SqlStorageValue>
          >(
            "SELECT COUNT(*) AS n FROM tasks WHERE state = 'working' AND desk = ?",
            desk,
          )).toArray();
          if ((busy[0]?.n ?? 0) >= (yield* widthOf(desk))) return undefined;
          // one round per session: two pumps racing the same trunk
          // slot must not both land on it — the loser re-reads and
          // forks a clone instead (Desks.ts's refresh-once retry)
          if (options?.session !== undefined) {
            const conflict = yield* (yield* sql.exec<TaskDbRow>(
              "SELECT id FROM tasks WHERE state = 'working' AND desk = ? AND session = ? LIMIT 1",
              desk,
              options.session,
            )).toArray();
            if (conflict.length > 0) return undefined;
          }
          let chosen: TaskRow | undefined;
          if (options?.preferred !== undefined) {
            const preferred = yield* taskOf(options.preferred);
            if (preferred !== undefined && preferred.state === from) {
              chosen = preferred;
            }
          }
          if (chosen === undefined) {
            // ready claims pop the MATERIALIZED rank's top (hint-then-
            // FIFO when no rank landed yet) — zero judging here; the
            // re-rank triggers (arrival/settle/reorder/retag) did it
            const rows = yield* (yield* (from === "ready"
              ? sql.exec<TaskDbRow>(
                  `SELECT * FROM tasks WHERE state = 'ready' ORDER BY ${READY_ORDER} LIMIT 1`,
                )
              : sql.exec<TaskDbRow>(
                  "SELECT * FROM tasks WHERE state = ? ORDER BY priority, at LIMIT 1",
                  from,
                ))).toArray();
            chosen = rows[0] === undefined ? undefined : toTask(rows[0]);
          }
          if (chosen === undefined) return undefined;
          // always rewritten — a stale session from a past round must
          // never point recovery at the wrong log. The worked-by
          // stamp is the desk's PERMANENT memory of having worked the
          // task (deskState.recent reads it even after review flips
          // the desk column to the reviewer).
          yield* sql.exec(
            "UPDATE tasks SET session = ?, worked_by = ? WHERE id = ?",
            options?.session ?? null,
            JSON.stringify([...new Set([...chosen.workedBy, desk])]),
            chosen.id,
          );
          yield* event(
            chosen.id,
            "assigned",
            "scheduler",
            JSON.stringify({
              desk,
              ...(options?.session === undefined
                ? {}
                : { session: options.session }),
            }),
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
            "SELECT * FROM tasks WHERE state = 'working' AND desk = ? ORDER BY updated",
            desk,
          )).toArray();
          // recent = tasks this desk WORKED, regardless of who holds
          // the desk column now — a completed task's desk flips to
          // the reviewer, which used to starve the engineer's
          // affinity signal of its own finished work
          const recent = yield* (yield* sql.exec<TaskDbRow>(
            "SELECT * FROM tasks WHERE state != 'working' AND (desk = ? OR worked_by LIKE ?) ORDER BY updated DESC LIMIT 5",
            desk,
            `%"${desk}"%`,
          )).toArray();
          return {
            working: working.map(toTask),
            width: yield* widthOf(desk),
            recent: recent.map((row) => ({
              title: row.title,
              tags: tagsOf(row.tags),
            })),
          };
        }),

        // the desk's parallelism dial — clamped, never trusted raw
        setWidth: Effect.fn(function* (desk, width) {
          const clamped = Math.min(
            MAX_DESK_WIDTH,
            Math.max(1, Math.round(width)),
          );
          yield* sql.exec(
            "INSERT INTO desk_settings (desk, width) VALUES (?, ?) ON CONFLICT (desk) DO UPDATE SET width = ?",
            desk,
            clamped,
            clamped,
          );
          return clamped;
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
    /** The human's drag — set the task's hint among READY siblings. */
    readonly reorder: (
      queue: string,
      id: string,
      input: ReorderInput,
    ) => Effect.Effect<TaskRow | undefined>;
    /** The scheduler's MAP cache (Scheduler.ts). */
    readonly scores: (
      queue: string,
    ) => Effect.Effect<ReadonlyArray<TaskScoreRow>>;
    readonly writeScore: (
      queue: string,
      id: string,
      hash: string,
      urgency: number,
      fit: Record<string, number>,
    ) => Effect.Effect<void>;
    /** Materialize one re-rank onto the board's ready rows. */
    readonly writeRanks: (
      queue: string,
      entries: ReadonlyArray<RankWrite>,
    ) => Effect.Effect<void>;
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
        readonly session?: string;
      },
    ) => Effect.Effect<TaskRow | undefined>;
    readonly deskState: (
      queue: string,
      desk: string,
    ) => Effect.Effect<DeskView>;
    /** Dial the desk's width (clamped 1..{@link MAX_DESK_WIDTH});
     *  answers the clamped value. */
    readonly setWidth: (
      queue: string,
      desk: string,
      width: number,
    ) => Effect.Effect<number>;
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
        reorder: (queue, id, input) =>
          inWorker(stub(queue).reorder(id, input)),
        scores: (queue) => inWorker(stub(queue).scores()),
        writeScore: (queue, id, hash, urgency, fit) =>
          inWorker(stub(queue).writeScore(id, hash, urgency, fit)),
        writeRanks: (queue, entries) =>
          inWorker(stub(queue).writeRanks(entries)),
        list: (queue, state) => inWorker(stub(queue).list(state)),
        get: (queue, id) => inWorker(stub(queue).get(id)),
        events: (queue, id) => inWorker(stub(queue).events(id)),
        claimNext: (queue, desk, options) =>
          inWorker(stub(queue).claimNext(desk, options)),
        deskState: (queue, desk) => inWorker(stub(queue).deskState(desk)),
        setWidth: (queue, desk, width) =>
          inWorker(stub(queue).setWidth(desk, width)),
        comment: (queue, id, actor, post) =>
          inWorker(stub(queue).comment(id, actor, post)),
        spendDispatch: (queue) => inWorker(stub(queue).spendDispatch()),
      });
    }),
  );
