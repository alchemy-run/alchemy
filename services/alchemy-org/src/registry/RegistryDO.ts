import * as Cloudflare from "alchemy/Cloudflare";
import type { MainRpc } from "alchemy/Platform";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { inWorker } from "../platform/Database.ts";
import {
  Registry,
  type ApprovalKind,
  type ApprovalPayload,
  type ApprovalStatus,
  type BoardSocketFrame,
  type BoardView,
  type EntityFilter,
  type RegistryApproval,
  type RegistryEntity,
  type RegistryGroup,
  type RegistryRelation,
  type RegistryTask,
  type RelationKind,
  type StageApprovalInput,
  type TaskStatus,
} from "./Registry.ts";

/**
 * The REGISTRY's Durable Object — ONE instance (`main`) for the whole
 * org, the ChannelDO pattern over a different concern: not a log but
 * the org's working memory (entities, groups, relations, tasks,
 * approvals, policy). Every write broadcasts the fresh {@link BoardView}
 * over the hibernatable `/board` WebSocket, so the kanban view is live
 * without a cursor protocol — the board is small state, snapshots are
 * the frame.
 */

const TAG = "board";

const TABLES = [
  `CREATE TABLE IF NOT EXISTS entities (
    ref TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT,
    labels TEXT NOT NULL DEFAULT '[]',
    head_ref TEXT,
    base_ref TEXT,
    updated_at INTEGER NOT NULL,
    synced_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    purpose TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL,
    ref TEXT NOT NULL,
    PRIMARY KEY (group_id, ref)
  )`,
  `CREATE TABLE IF NOT EXISTS relations (
    src TEXT NOT NULL,
    kind TEXT NOT NULL,
    dst TEXT NOT NULL,
    note TEXT,
    PRIMARY KEY (src, kind, dst)
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo',
    group_id TEXT,
    thread_id TEXT,
    note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS task_refs (
    task_id TEXT NOT NULL,
    ref TEXT NOT NULL,
    PRIMARY KEY (task_id, ref)
  )`,
  `CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    summary TEXT NOT NULL,
    payload TEXT NOT NULL,
    stager_term TEXT NOT NULL,
    stager_key TEXT NOT NULL,
    task_id TEXT,
    thread_id TEXT,
    card_id TEXT,
    outcome TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS policy (
    kind TEXT PRIMARY KEY,
    gated INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

/** Columns ALTERed in after the table shipped (none yet). */
const MIGRATIONS: ReadonlyArray<readonly [column: string, ddl: string]> = [];

interface EntityRow extends Record<string, Cloudflare.SqlStorageValue> {
  ref: string;
  kind: string;
  state: string;
  title: string;
  author: string | null;
  labels: string;
  head_ref: string | null;
  base_ref: string | null;
  updated_at: number;
  synced_at: number;
}

interface GroupRow extends Record<string, Cloudflare.SqlStorageValue> {
  id: string;
  name: string;
  purpose: string | null;
  created_at: number;
}

interface TaskRow extends Record<string, Cloudflare.SqlStorageValue> {
  id: string;
  title: string;
  status: string;
  group_id: string | null;
  thread_id: string | null;
  note: string | null;
  created_at: number;
  updated_at: number;
}

interface ApprovalRow extends Record<string, Cloudflare.SqlStorageValue> {
  id: string;
  kind: string;
  status: string;
  summary: string;
  payload: string;
  stager_term: string;
  stager_key: string;
  task_id: string | null;
  thread_id: string | null;
  card_id: string | null;
  outcome: string | null;
  created_at: number;
  decided_at: number | null;
}

const toEntity = (row: EntityRow): RegistryEntity => ({
  ref: row.ref,
  kind: row.kind as RegistryEntity["kind"],
  state: row.state as RegistryEntity["state"],
  title: row.title,
  ...(row.author === null ? {} : { author: row.author }),
  labels: JSON.parse(row.labels) as ReadonlyArray<string>,
  ...(row.head_ref === null ? {} : { headRef: row.head_ref }),
  ...(row.base_ref === null ? {} : { baseRef: row.base_ref }),
  updatedAt: row.updated_at,
  syncedAt: row.synced_at,
});

const toApproval = (row: ApprovalRow): RegistryApproval => ({
  id: row.id,
  kind: row.kind as ApprovalKind,
  status: row.status as ApprovalStatus,
  summary: row.summary,
  payload: JSON.parse(row.payload) as ApprovalPayload,
  stager: { term: row.stager_term, key: row.stager_key },
  ...(row.task_id === null ? {} : { taskId: row.task_id }),
  ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
  ...(row.card_id === null ? {} : { cardId: row.card_id }),
  ...(row.outcome === null ? {} : { outcome: row.outcome }),
  createdAt: row.created_at,
  ...(row.decided_at === null ? {} : { decidedAt: row.decided_at }),
});

/** Refs per `IN (…)` — under SQLite storage's 100-parameter cap. */
const IN_PAGE = 50;

interface RegistryRpc extends MainRpc<Cloudflare.DurableObjectState> {
  readonly upsertEntities: (
    entities: ReadonlyArray<Omit<RegistryEntity, "syncedAt">>,
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly queryEntities: (
    filter?: EntityFilter,
  ) => Effect.Effect<ReadonlyArray<RegistryEntity>, never, RuntimeContext>;
  readonly createGroup: (input: {
    readonly name: string;
    readonly purpose?: string;
    readonly refs?: ReadonlyArray<string>;
  }) => Effect.Effect<RegistryGroup, never, RuntimeContext>;
  readonly addToGroup: (
    group: string,
    refs: ReadonlyArray<string>,
  ) => Effect.Effect<RegistryGroup | undefined, never, RuntimeContext>;
  readonly removeFromGroup: (
    group: string,
    refs: ReadonlyArray<string>,
  ) => Effect.Effect<RegistryGroup | undefined, never, RuntimeContext>;
  readonly relate: (
    relation: RegistryRelation,
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly unrelate: (
    src: string,
    kind: RelationKind,
    dst: string,
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly relationsOf: (
    ref: string,
  ) => Effect.Effect<ReadonlyArray<RegistryRelation>, never, RuntimeContext>;
  readonly createTask: (input: {
    readonly title: string;
    readonly refs?: ReadonlyArray<string>;
    readonly groupId?: string;
    readonly note?: string;
  }) => Effect.Effect<RegistryTask, never, RuntimeContext>;
  readonly updateTask: (
    id: string,
    patch: {
      readonly title?: string;
      readonly status?: TaskStatus;
      readonly note?: string;
      readonly refs?: ReadonlyArray<string>;
    },
  ) => Effect.Effect<RegistryTask | undefined, never, RuntimeContext>;
  readonly linkThread: (
    id: string,
    threadId: string | null,
  ) => Effect.Effect<RegistryTask | undefined, never, RuntimeContext>;
  readonly board: () => Effect.Effect<BoardView, never, RuntimeContext>;
  readonly stageApproval: (
    input: StageApprovalInput,
  ) => Effect.Effect<RegistryApproval, never, RuntimeContext>;
  readonly readApproval: (
    id: string,
  ) => Effect.Effect<RegistryApproval | undefined, never, RuntimeContext>;
  readonly attachApprovalCard: (
    id: string,
    cardId: string,
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly decideApproval: (
    id: string,
    status: Exclude<ApprovalStatus, "pending">,
    outcome?: string,
  ) => Effect.Effect<RegistryApproval | undefined, never, RuntimeContext>;
  readonly pendingApprovals: () => Effect.Effect<
    ReadonlyArray<RegistryApproval>,
    never,
    RuntimeContext
  >;
  readonly listApprovals: (
    status: ApprovalStatus,
  ) => Effect.Effect<ReadonlyArray<RegistryApproval>, never, RuntimeContext>;
  readonly gated: (
    kind: ApprovalKind,
  ) => Effect.Effect<boolean, never, RuntimeContext>;
  readonly setPolicy: (
    kind: ApprovalKind,
    gated: boolean,
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly policy: () => Effect.Effect<
    ReadonlyArray<{ readonly kind: ApprovalKind; readonly gated: boolean }>,
    never,
    RuntimeContext
  >;
}

const RegistryDOLive = Cloudflare.DurableObject<RegistryRpc>()(
  "RegistryDO",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const sql = state.storage.sql;

    const refsOf = Effect.fn(function* (table: string, key: string, id: string) {
      const cursor = yield* sql.exec<
        { ref: string } & Record<string, Cloudflare.SqlStorageValue>
      >(`SELECT ref FROM ${table} WHERE ${key} = ? ORDER BY ref`, id);
      return (yield* cursor.toArray()).map((row) => row.ref);
    });

    const groupById = Effect.fn(function* (id: string) {
      const cursor = yield* sql.exec<GroupRow>(
        "SELECT * FROM groups WHERE id = ? OR name = ?",
        id,
        id,
      );
      const row = (yield* cursor.toArray())[0];
      if (row === undefined) return undefined;
      return {
        id: row.id,
        name: row.name,
        ...(row.purpose === null ? {} : { purpose: row.purpose }),
        createdAt: row.created_at,
        refs: yield* refsOf("group_members", "group_id", row.id),
      } satisfies RegistryGroup;
    });

    const taskById = Effect.fn(function* (id: string) {
      const cursor = yield* sql.exec<TaskRow>(
        "SELECT * FROM tasks WHERE id = ?",
        id,
      );
      const row = (yield* cursor.toArray())[0];
      if (row === undefined) return undefined;
      return toTask(row, yield* refsOf("task_refs", "task_id", row.id));
    });

    const toTask = (row: TaskRow, refs: ReadonlyArray<string>): RegistryTask => ({
      id: row.id,
      title: row.title,
      status: row.status as TaskStatus,
      ...(row.group_id === null ? {} : { groupId: row.group_id }),
      ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
      ...(row.note === null ? {} : { note: row.note }),
      refs,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });

    const approvalById = Effect.fn(function* (id: string) {
      const cursor = yield* sql.exec<ApprovalRow>(
        "SELECT * FROM approvals WHERE id = ?",
        id,
      );
      const row = (yield* cursor.toArray())[0];
      return row === undefined ? undefined : toApproval(row);
    });

    const readBoard = Effect.gen(function* () {
      const groupRows = yield* (yield* sql.exec<GroupRow>(
        "SELECT * FROM groups ORDER BY created_at ASC",
      )).toArray();
      const groups: Array<RegistryGroup> = [];
      for (const row of groupRows) {
        groups.push({
          id: row.id,
          name: row.name,
          ...(row.purpose === null ? {} : { purpose: row.purpose }),
          createdAt: row.created_at,
          refs: yield* refsOf("group_members", "group_id", row.id),
        });
      }
      const taskRows = yield* (yield* sql.exec<TaskRow>(
        "SELECT * FROM tasks ORDER BY updated_at DESC",
      )).toArray();
      const pending = yield* (yield* sql.exec<ApprovalRow>(
        "SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC",
      )).toArray();
      const tasks: BoardView["tasks"][number][] = [];
      for (const row of taskRows) {
        tasks.push({
          ...toTask(row, yield* refsOf("task_refs", "task_id", row.id)),
          pendingApprovals: pending.filter((a) => a.task_id === row.id).length,
        });
      }
      // every ref any task or group mentions, resolved to snapshots
      const mentioned = [
        ...new Set([
          ...tasks.flatMap((task) => task.refs),
          ...groups.flatMap((group) => group.refs),
        ]),
      ];
      const entities: Array<RegistryEntity> = [];
      for (let i = 0; i < mentioned.length; i += IN_PAGE) {
        const page = mentioned.slice(i, i + IN_PAGE);
        const cursor = yield* sql.exec<EntityRow>(
          `SELECT * FROM entities WHERE ref IN (${page.map(() => "?").join(", ")})`,
          ...page,
        );
        entities.push(...(yield* cursor.toArray()).map(toEntity));
      }
      // the triage tray: open entities organized into NOTHING
      const triage = yield* (yield* sql.exec<EntityRow>(
        `SELECT * FROM entities WHERE state IN ('open', 'draft')
           AND ref NOT IN (SELECT ref FROM group_members)
           AND ref NOT IN (SELECT ref FROM task_refs)
         ORDER BY updated_at DESC`
          .trim()
          .replaceAll(/\s+/g, " "),
      )).toArray();
      return {
        tasks,
        groups,
        triage: triage.map(toEntity),
        entities,
        approvals: pending.map(toApproval),
      } satisfies BoardView;
    });

    const broadcast = Effect.gen(function* () {
      const sockets = yield* state.getWebSockets(TAG);
      if (sockets.length === 0) return;
      const frame: BoardSocketFrame = { type: "board", board: yield* readBoard };
      const data = JSON.stringify(frame);
      yield* Effect.forEach(
        sockets,
        (socket) => Effect.ignore(socket.send(data)),
        { discard: true },
      );
    });

    return Effect.gen(function* () {
      yield* Effect.forEach(
        TABLES,
        (table) =>
          sql.exec(table.trim().replaceAll(/\s+/g, " ")).pipe(Effect.asVoid),
        { discard: true },
      );
      const info = yield* sql.exec<
        { name: string } & Record<string, Cloudflare.SqlStorageValue>
      >("PRAGMA table_info(entities)");
      const columns = new Set((yield* info.toArray()).map((c) => c.name));
      for (const [column, ddl] of MIGRATIONS) {
        if (!columns.has(column)) yield* sql.exec(ddl);
      }

      return {
        /** The `/board` WebSocket — a snapshot on subscribe, then a
         *  fresh snapshot after every write. */
        fetch: Effect.gen(function* () {
          const [response] = yield* Cloudflare.upgrade({ tags: [TAG] });
          return response;
        }),

        webSocketMessage: Effect.fn(
          function* (socket: Cloudflare.WebSocket, _message) {
            const frame: BoardSocketFrame = {
              type: "board",
              board: yield* readBoard,
            };
            yield* Effect.ignore(socket.send(JSON.stringify(frame)));
          },
          Effect.catchDefect((defect) =>
            Effect.logWarning(`[board-socket] bad frame: ${String(defect)}`),
          ),
        ),

        webSocketClose: Effect.fn(function* (
          socket: Cloudflare.WebSocket,
          code: number,
          reason: string,
        ) {
          const echo = code === 1005 || code === 1006 || code === 1015;
          yield* Effect.ignore(
            socket.close(echo ? 1000 : code, echo ? "" : reason),
          );
        }),

        upsertEntities: Effect.fn(function* (entities) {
          const at = yield* Clock.currentTimeMillis;
          for (const entity of entities) {
            yield* sql.exec(
              `INSERT OR REPLACE INTO entities
                 (ref, kind, state, title, author, labels, head_ref, base_ref, updated_at, synced_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                .trim()
                .replaceAll(/\s+/g, " "),
              entity.ref,
              entity.kind,
              entity.state,
              entity.title,
              entity.author ?? null,
              JSON.stringify(entity.labels),
              entity.headRef ?? null,
              entity.baseRef ?? null,
              entity.updatedAt,
              at,
            );
          }
          yield* broadcast;
        }),

        queryEntities: Effect.fn(function* (filter) {
          const where: Array<string> = [];
          const binds: Array<string | number> = [];
          if (filter?.kind !== undefined) {
            where.push("kind = ?");
            binds.push(filter.kind);
          }
          if (filter?.state !== undefined) {
            where.push("state = ?");
            binds.push(filter.state);
          }
          if (filter?.label !== undefined) {
            where.push("labels LIKE ?");
            binds.push(`%${JSON.stringify(filter.label)}%`);
          }
          if (filter?.group !== undefined) {
            const group = yield* groupById(filter.group);
            where.push(
              "ref IN (SELECT ref FROM group_members WHERE group_id = ?)",
            );
            binds.push(group?.id ?? filter.group);
          }
          if (filter?.unorganized === true) {
            where.push(
              "ref NOT IN (SELECT ref FROM group_members)",
              "ref NOT IN (SELECT ref FROM task_refs)",
            );
          }
          if (filter?.q !== undefined && filter.q.length > 0) {
            where.push("(ref LIKE ? COLLATE NOCASE OR title LIKE ? COLLATE NOCASE)");
            binds.push(`%${filter.q}%`, `%${filter.q}%`);
          }
          const limit = Math.min(filter?.limit ?? 200, 500);
          const cursor = yield* sql.exec<EntityRow>(
            `SELECT * FROM entities${
              where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""
            } ORDER BY updated_at DESC LIMIT ${limit}`,
            ...binds,
          );
          return (yield* cursor.toArray()).map(toEntity);
        }),

        createGroup: Effect.fn(function* (input) {
          const existing = yield* groupById(input.name);
          if (existing !== undefined) return existing;
          const id = `g-${crypto.randomUUID().slice(0, 8)}`;
          const at = yield* Clock.currentTimeMillis;
          yield* sql.exec(
            "INSERT INTO groups (id, name, purpose, created_at) VALUES (?, ?, ?, ?)",
            id,
            input.name,
            input.purpose ?? null,
            at,
          );
          for (const ref of input.refs ?? []) {
            yield* sql.exec(
              "INSERT OR IGNORE INTO group_members (group_id, ref) VALUES (?, ?)",
              id,
              ref,
            );
          }
          yield* broadcast;
          return (yield* groupById(id))!;
        }),

        addToGroup: Effect.fn(function* (group, refs) {
          const found = yield* groupById(group);
          if (found === undefined) return undefined;
          for (const ref of refs) {
            yield* sql.exec(
              "INSERT OR IGNORE INTO group_members (group_id, ref) VALUES (?, ?)",
              found.id,
              ref,
            );
          }
          yield* broadcast;
          return yield* groupById(found.id);
        }),

        removeFromGroup: Effect.fn(function* (group, refs) {
          const found = yield* groupById(group);
          if (found === undefined) return undefined;
          for (const ref of refs) {
            yield* sql.exec(
              "DELETE FROM group_members WHERE group_id = ? AND ref = ?",
              found.id,
              ref,
            );
          }
          yield* broadcast;
          return yield* groupById(found.id);
        }),

        relate: Effect.fn(function* (relation) {
          yield* sql.exec(
            "INSERT OR REPLACE INTO relations (src, kind, dst, note) VALUES (?, ?, ?, ?)",
            relation.src,
            relation.kind,
            relation.dst,
            relation.note ?? null,
          );
          yield* broadcast;
        }),

        unrelate: Effect.fn(function* (src, kind, dst) {
          yield* sql.exec(
            "DELETE FROM relations WHERE src = ? AND kind = ? AND dst = ?",
            src,
            kind,
            dst,
          );
          yield* broadcast;
        }),

        relationsOf: Effect.fn(function* (ref) {
          const cursor = yield* sql.exec<
            {
              src: string;
              kind: string;
              dst: string;
              note: string | null;
            } & Record<string, Cloudflare.SqlStorageValue>
          >("SELECT * FROM relations WHERE src = ? OR dst = ?", ref, ref);
          return (yield* cursor.toArray()).map((row) => ({
            src: row.src,
            kind: row.kind as RelationKind,
            dst: row.dst,
            ...(row.note === null ? {} : { note: row.note }),
          }));
        }),

        createTask: Effect.fn(function* (input) {
          const id = `task-${crypto.randomUUID().slice(0, 8)}`;
          const at = yield* Clock.currentTimeMillis;
          yield* sql.exec(
            `INSERT INTO tasks (id, title, status, group_id, thread_id, note, created_at, updated_at)
             VALUES (?, ?, 'todo', ?, NULL, ?, ?, ?)`
              .trim()
              .replaceAll(/\s+/g, " "),
            id,
            input.title,
            input.groupId ?? null,
            input.note ?? null,
            at,
            at,
          );
          for (const ref of input.refs ?? []) {
            yield* sql.exec(
              "INSERT OR IGNORE INTO task_refs (task_id, ref) VALUES (?, ?)",
              id,
              ref,
            );
          }
          yield* broadcast;
          return (yield* taskById(id))!;
        }),

        updateTask: Effect.fn(function* (id, patch) {
          const current = yield* taskById(id);
          if (current === undefined) return undefined;
          const at = yield* Clock.currentTimeMillis;
          yield* sql.exec(
            "UPDATE tasks SET title = ?, status = ?, note = ?, updated_at = ? WHERE id = ?",
            patch.title ?? current.title,
            patch.status ?? current.status,
            patch.note ?? current.note ?? null,
            at,
            id,
          );
          if (patch.refs !== undefined) {
            yield* sql.exec("DELETE FROM task_refs WHERE task_id = ?", id);
            for (const ref of patch.refs) {
              yield* sql.exec(
                "INSERT OR IGNORE INTO task_refs (task_id, ref) VALUES (?, ?)",
                id,
                ref,
              );
            }
          }
          yield* broadcast;
          return yield* taskById(id);
        }),

        linkThread: Effect.fn(function* (id, threadId) {
          const current = yield* taskById(id);
          if (current === undefined) return undefined;
          const at = yield* Clock.currentTimeMillis;
          yield* sql.exec(
            "UPDATE tasks SET thread_id = ?, status = ?, updated_at = ? WHERE id = ?",
            threadId,
            threadId === null ? current.status : "dispatched",
            at,
            id,
          );
          yield* broadcast;
          return yield* taskById(id);
        }),

        board: () => readBoard,

        stageApproval: Effect.fn(function* (input) {
          const id = `appr-${crypto.randomUUID().slice(0, 8)}`;
          const at = yield* Clock.currentTimeMillis;
          yield* sql.exec(
            `INSERT INTO approvals
               (id, kind, status, summary, payload, stager_term, stager_key, task_id, thread_id, card_id, outcome, created_at, decided_at)
             VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`
              .trim()
              .replaceAll(/\s+/g, " "),
            id,
            input.kind,
            input.summary,
            JSON.stringify(input.payload),
            input.stager.term,
            input.stager.key,
            input.taskId ?? null,
            input.threadId ?? null,
            input.cardId ?? null,
            at,
          );
          yield* broadcast;
          return (yield* approvalById(id))!;
        }),

        readApproval: Effect.fn(function* (id) {
          return yield* approvalById(id);
        }),

        attachApprovalCard: Effect.fn(function* (id, cardId) {
          yield* sql.exec(
            "UPDATE approvals SET card_id = ? WHERE id = ?",
            cardId,
            id,
          );
        }),

        decideApproval: Effect.fn(function* (id, status, outcome) {
          const current = yield* approvalById(id);
          if (current === undefined) return undefined;
          const at = yield* Clock.currentTimeMillis;
          yield* sql.exec(
            "UPDATE approvals SET status = ?, outcome = ?, decided_at = ? WHERE id = ?",
            status,
            outcome ?? current.outcome ?? null,
            at,
            id,
          );
          yield* broadcast;
          return yield* approvalById(id);
        }),

        pendingApprovals: Effect.fn(function* () {
          const cursor = yield* sql.exec<ApprovalRow>(
            "SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC",
          );
          return (yield* cursor.toArray()).map(toApproval);
        }),

        listApprovals: Effect.fn(function* (status) {
          const cursor = yield* sql.exec<ApprovalRow>(
            "SELECT * FROM approvals WHERE status = ? ORDER BY created_at ASC",
            status,
          );
          return (yield* cursor.toArray()).map(toApproval);
        }),

        // policy: unset means GATED — safety is the default; the
        // operator loosens kinds explicitly, in conversation
        gated: Effect.fn(function* (kind) {
          const cursor = yield* sql.exec<
            { gated: number } & Record<string, Cloudflare.SqlStorageValue>
          >("SELECT gated FROM policy WHERE kind = ?", kind);
          const row = (yield* cursor.toArray())[0];
          return row === undefined ? true : row.gated === 1;
        }),

        setPolicy: Effect.fn(function* (kind, gated) {
          yield* sql.exec(
            "INSERT OR REPLACE INTO policy (kind, gated) VALUES (?, ?)",
            kind,
            gated ? 1 : 0,
          );
          yield* broadcast;
        }),

        policy: Effect.fn(function* () {
          const kinds: ReadonlyArray<ApprovalKind> = [
            "comment",
            "push",
            "open_pull",
            "merge",
            "close",
          ];
          const cursor = yield* sql.exec<
            { kind: string; gated: number } & Record<
              string,
              Cloudflare.SqlStorageValue
            >
          >("SELECT kind, gated FROM policy");
          const set = new Map(
            (yield* cursor.toArray()).map((row) => [row.kind, row.gated === 1]),
          );
          return kinds.map((kind) => ({
            kind,
            gated: set.get(kind) ?? true,
          }));
        }),
      } satisfies RegistryRpc;
    });
  }),
);

/** The ONE registry instance's name. */
const MAIN = "main";

/**
 * The {@link Registry} facade over the one RegistryDO. Requires the
 * host `Worker`: yielding the Durable Object while this Layer builds
 * declares it as a binding of the Worker whose bundle carries its
 * class.
 */
export const RegistryLive: Layer.Layer<Registry, never, Cloudflare.Worker> =
  Layer.effect(
    Registry,
    Effect.gen(function* () {
      const namespace = yield* RegistryDOLive;
      const stub = () => namespace.getByName(MAIN);
      return Registry.of({
        upsertEntities: (entities) => inWorker(stub().upsertEntities(entities)),
        queryEntities: (filter) => inWorker(stub().queryEntities(filter)),
        createGroup: (input) => inWorker(stub().createGroup(input)),
        addToGroup: (group, refs) => inWorker(stub().addToGroup(group, refs)),
        removeFromGroup: (group, refs) =>
          inWorker(stub().removeFromGroup(group, refs)),
        relate: (relation) => inWorker(stub().relate(relation)),
        unrelate: (src, kind, dst) => inWorker(stub().unrelate(src, kind, dst)),
        relationsOf: (ref) => inWorker(stub().relationsOf(ref)),
        createTask: (input) => inWorker(stub().createTask(input)),
        updateTask: (id, patch) => inWorker(stub().updateTask(id, patch)),
        linkThread: (id, threadId) => inWorker(stub().linkThread(id, threadId)),
        board: () => inWorker(stub().board()),
        stageApproval: (input) => inWorker(stub().stageApproval(input)),
        readApproval: (id) => inWorker(stub().readApproval(id)),
        attachApprovalCard: (id, cardId) =>
          inWorker(stub().attachApprovalCard(id, cardId)),
        decideApproval: (id, status, outcome) =>
          inWorker(stub().decideApproval(id, status, outcome)),
        pendingApprovals: () => inWorker(stub().pendingApprovals()),
        listApprovals: (status) => inWorker(stub().listApprovals(status)),
        gated: (kind) => inWorker(stub().gated(kind)),
        setPolicy: (kind, gated) => inWorker(stub().setPolicy(kind, gated)),
        policy: () => inWorker(stub().policy()),
        socket: (request) => inWorker(stub().fetch(request).pipe(Effect.orDie)),
      });
    }),
  );
