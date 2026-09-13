import * as Cloudflare from "alchemy/Cloudflare";
import type { MainRpc } from "alchemy/Platform";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { inWorker } from "../platform/Database.ts";
import { Tasks, type Task, type TaskItem, type TaskStatus } from "./Tasks.ts";
import { Triage } from "./Triage.ts";

/**
 * ENGINEERING's Durable Object — ONE instance (`main`) holding the
 * team's working memory: the inbound DEDUPE (webhooks redeliver, the
 * dev poller re-synthesizes; the manager's SESSION is the queue — the
 * driver owns ordering, durability, waking, and the channel's stop
 * button owns the flow) and the TASK LEDGER. One SQLite database, one
 * single-threaded turn per verb.
 */

const TABLES = [
  `CREATE TABLE IF NOT EXISTS delivered (
    key TEXT PRIMARY KEY
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo',
    assignee TEXT,
    workspace TEXT,
    notes TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS task_items (
    task_id TEXT NOT NULL,
    ref TEXT NOT NULL,
    kind TEXT NOT NULL,
    PRIMARY KEY (task_id, ref)
  )`,
];

interface TaskRow extends Record<string, Cloudflare.SqlStorageValue> {
  id: string;
  title: string;
  status: string;
  assignee: string | null;
  workspace: string | null;
  notes: string;
  created_at: number;
  updated_at: number;
}

interface EngineeringRpc extends MainRpc<Cloudflare.DurableObjectState> {
  readonly delivered: (
    key: string,
  ) => Effect.Effect<boolean, never, RuntimeContext>;
  readonly taskUpsert: (input: {
    readonly id?: string;
    readonly title?: string;
    readonly status?: TaskStatus;
    readonly assignee?: string | null;
    readonly workspace?: string | null;
    readonly addItems?: ReadonlyArray<TaskItem>;
    readonly removeItems?: ReadonlyArray<string>;
    readonly note?: string;
  }) => Effect.Effect<Task, never, RuntimeContext>;
  readonly taskRead: (
    id: string,
  ) => Effect.Effect<Task | undefined, never, RuntimeContext>;
  readonly taskList: (
    status?: TaskStatus,
  ) => Effect.Effect<ReadonlyArray<Task>, never, RuntimeContext>;
  readonly taskCovering: (
    ref: string,
  ) => Effect.Effect<Task | undefined, never, RuntimeContext>;
}

const TriageDOLive = Cloudflare.DurableObject<EngineeringRpc>()(
  "TriageDO",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const sql = state.storage.sql;

    const itemsOf = Effect.fn(function* (taskId: string) {
      const cursor = yield* sql.exec<
        { ref: string; kind: string } & Record<
          string,
          Cloudflare.SqlStorageValue
        >
      >("SELECT ref, kind FROM task_items WHERE task_id = ? ORDER BY ref", taskId);
      return (yield* cursor.toArray()).map(
        (row): TaskItem => ({ ref: row.ref, kind: row.kind as TaskItem["kind"] }),
      );
    });

    const toTask = Effect.fn(function* (row: TaskRow) {
      return {
        id: row.id,
        title: row.title,
        status: row.status as TaskStatus,
        ...(row.assignee === null ? {} : { assignee: row.assignee }),
        ...(row.workspace === null ? {} : { workspace: row.workspace }),
        notes: JSON.parse(row.notes) as ReadonlyArray<string>,
        items: yield* itemsOf(row.id),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      } satisfies Task;
    });

    const taskById = Effect.fn(function* (id: string) {
      const cursor = yield* sql.exec<TaskRow>(
        "SELECT * FROM tasks WHERE id = ?",
        id,
      );
      const row = (yield* cursor.toArray())[0];
      return row === undefined ? undefined : yield* toTask(row);
    });

    return Effect.gen(function* () {
      yield* Effect.forEach(
        TABLES,
        (table) =>
          sql.exec(table.trim().replaceAll(/\s+/g, " ")).pipe(Effect.asVoid),
        { discard: true },
      );

      return {
        delivered: Effect.fn(function* (key) {
          const seen = yield* (yield* sql.exec<
            { n: number } & Record<string, Cloudflare.SqlStorageValue>
          >(
            "SELECT COUNT(*) AS n FROM delivered WHERE key = ?",
            key,
          )).toArray();
          if ((seen[0]?.n ?? 0) > 0) return true;
          yield* sql.exec("INSERT INTO delivered (key) VALUES (?)", key);
          return false;
        }),

        taskUpsert: Effect.fn(function* (input) {
          const at = yield* Clock.currentTimeMillis;
          const existing =
            input.id === undefined ? undefined : yield* taskById(input.id);
          const id =
            existing?.id ??
            `t-${at.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          if (existing === undefined) {
            yield* sql.exec(
              `INSERT INTO tasks (id, title, status, assignee, workspace, notes, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                .trim()
                .replaceAll(/\s+/g, " "),
              id,
              input.title ?? "(untitled)",
              input.status ?? "todo",
              input.assignee ?? null,
              input.workspace ?? null,
              JSON.stringify(input.note === undefined ? [] : [input.note]),
              at,
              at,
            );
          } else {
            const notes =
              input.note === undefined
                ? existing.notes
                : [...existing.notes, input.note];
            yield* sql.exec(
              `UPDATE tasks SET title = ?, status = ?, assignee = ?, workspace = ?, notes = ?, updated_at = ?
               WHERE id = ?`
                .trim()
                .replaceAll(/\s+/g, " "),
              input.title ?? existing.title,
              input.status ?? existing.status,
              input.assignee === undefined
                ? (existing.assignee ?? null)
                : input.assignee,
              input.workspace === undefined
                ? (existing.workspace ?? null)
                : input.workspace,
              JSON.stringify(notes),
              at,
              id,
            );
          }
          for (const item of input.addItems ?? []) {
            yield* sql.exec(
              "INSERT OR REPLACE INTO task_items (task_id, ref, kind) VALUES (?, ?, ?)",
              id,
              item.ref,
              item.kind,
            );
          }
          for (const ref of input.removeItems ?? []) {
            yield* sql.exec(
              "DELETE FROM task_items WHERE task_id = ? AND ref = ?",
              id,
              ref,
            );
          }
          return (yield* taskById(id))!;
        }),

        taskRead: Effect.fn(function* (id) {
          return yield* taskById(id);
        }),

        taskList: Effect.fn(function* (status) {
          const cursor =
            status === undefined
              ? yield* sql.exec<TaskRow>(
                  "SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 200",
                )
              : yield* sql.exec<TaskRow>(
                  "SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC",
                  status,
                );
          const rows = yield* cursor.toArray();
          const tasks: Array<Task> = [];
          for (const row of rows) {
            tasks.push(yield* toTask(row));
          }
          return tasks;
        }),

        taskCovering: Effect.fn(function* (ref) {
          const cursor = yield* sql.exec<
            { task_id: string } & Record<string, Cloudflare.SqlStorageValue>
          >("SELECT task_id FROM task_items WHERE ref = ? LIMIT 1", ref);
          const row = (yield* cursor.toArray())[0];
          return row === undefined ? undefined : yield* taskById(row.task_id);
        }),
      } satisfies EngineeringRpc;
    });
  }),
);

/** The ONE engineering instance's name. */
const MAIN = "main";

/** The {@link Triage} facade over the one TriageDO. */
export const TriageLive: Layer.Layer<Triage, never, Cloudflare.Worker> =
  Layer.effect(
    Triage,
    Effect.gen(function* () {
      const namespace = yield* TriageDOLive;
      const stub = () => namespace.getByName(MAIN);
      return Triage.of({
        delivered: (key) => inWorker(stub().delivered(key)),
      });
    }),
  );

/** The {@link Tasks} facade over the same DO. */
export const TasksLive: Layer.Layer<Tasks, never, Cloudflare.Worker> =
  Layer.effect(
    Tasks,
    Effect.gen(function* () {
      const namespace = yield* TriageDOLive;
      const stub = () => namespace.getByName(MAIN);
      return Tasks.of({
        upsert: (input) => inWorker(stub().taskUpsert(input)),
        read: (id) => inWorker(stub().taskRead(id)),
        list: (status) => inWorker(stub().taskList(status)),
        covering: (ref) => inWorker(stub().taskCovering(ref)),
      });
    }),
  );
