import * as Cloudflare from "alchemy/Cloudflare";
import type { MainRpc } from "alchemy/Platform";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { inWorker } from "../platform/Database.ts";
import { Asks, type AskNode } from "./Asks.ts";
import { Calls, type CallUtterance, type CallView } from "./Call.ts";

/**
 * The CHAT domain's Durable Object — ONE instance (`main`) holding the
 * company's conversation structure:
 *
 * - the ASK TREE: every ask is a node (asker, target, question, answer,
 *   PARENT ask) — the chain a question travelled is a path in this
 *   tree, and the UI renders any node's SUBTREE reddit-style: a
 *   question's children are the asks its target made while answering.
 * - CALLS: the shared transcripts (topic, members, utterances) and the
 *   per-member WATERMARKS that make delivery incremental — an ask on a
 *   call carries only the utterances its target has not yet seen.
 *
 * One SQLite database, one single-threaded turn per verb: tree edges,
 * seq order, and watermark reads are the storage's guarantees.
 */

const TAG = "calls";

const TABLES = [
  `CREATE TABLE IF NOT EXISTS asks (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    call_id TEXT,
    asker TEXT NOT NULL,
    target TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    at INTEGER NOT NULL,
    answered_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS asks_parent ON asks (parent_id)`,
  `CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    initiator TEXT NOT NULL,
    members TEXT NOT NULL,
    open INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS utterances (
    call_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (call_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS watermarks (
    call_id TEXT NOT NULL,
    member TEXT NOT NULL,
    seen_seq INTEGER NOT NULL,
    PRIMARY KEY (call_id, member)
  )`,
];

interface AskRow extends Record<string, Cloudflare.SqlStorageValue> {
  id: string;
  parent_id: string | null;
  call_id: string | null;
  asker: string;
  target: string;
  question: string;
  answer: string | null;
  status: string;
  at: number;
  answered_at: number | null;
}

interface CallRow extends Record<string, Cloudflare.SqlStorageValue> {
  id: string;
  topic: string;
  initiator: string;
  members: string;
  open: number;
  created_at: number;
}

interface UtteranceRow extends Record<string, Cloudflare.SqlStorageValue> {
  call_id: string;
  seq: number;
  author: string;
  text: string;
  at: number;
}

const toNode = (row: AskRow): AskNode => ({
  id: row.id,
  ...(row.parent_id === null ? {} : { parent: row.parent_id }),
  ...(row.call_id === null ? {} : { call: row.call_id }),
  asker: row.asker,
  target: row.target,
  question: row.question,
  ...(row.answer === null ? {} : { answer: row.answer }),
  status: row.status as AskNode["status"],
  at: row.at,
  children: [],
});

interface ChatRpc extends MainRpc<Cloudflare.DurableObjectState> {
  // ── the ask tree ──
  readonly askOpen: (input: {
    readonly id: string;
    readonly parent?: string;
    readonly call?: string;
    readonly asker: string;
    readonly target: string;
    readonly question: string;
  }) => Effect.Effect<void, never, RuntimeContext>;
  readonly askSettle: (
    id: string,
    status: "answered" | "failed",
    answer: string,
  ) => Effect.Effect<void, never, RuntimeContext>;
  /** The SUBTREE under one ask (children nested, chronological). */
  readonly askTree: (
    id: string,
  ) => Effect.Effect<AskNode | undefined, never, RuntimeContext>;
  /** Root asks (no parent), newest first — the company's activity. */
  readonly askRoots: (
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<AskNode>, never, RuntimeContext>;

  // ── calls ──
  readonly open: (input: {
    readonly initiator: string;
    readonly members: ReadonlyArray<string>;
    readonly topic: string;
  }) => Effect.Effect<string, never, RuntimeContext>;
  readonly append: (
    id: string,
    utterance: { readonly author: string; readonly text: string },
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly read: (
    id: string,
  ) => Effect.Effect<CallView | undefined, never, RuntimeContext>;
  /** The utterances `member` has not seen (not theirs), and advance
   *  the watermark past everything current — the DELTA an ask carries
   *  as pre-history. */
  readonly since: (
    id: string,
    member: string,
  ) => Effect.Effect<ReadonlyArray<CallUtterance>, never, RuntimeContext>;
}

const ChatDOLive = Cloudflare.DurableObject<ChatRpc>()(
  "ChatDO",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const sql = state.storage.sql;

    const viewOf = Effect.fn(function* (id: string) {
      const rows = yield* (yield* sql.exec<CallRow>(
        "SELECT * FROM calls WHERE id = ?",
        id,
      )).toArray();
      const row = rows[0];
      if (row === undefined) return undefined;
      const utterances = yield* (yield* sql.exec<UtteranceRow>(
        "SELECT * FROM utterances WHERE call_id = ? ORDER BY seq ASC",
        id,
      )).toArray();
      return {
        id: row.id,
        topic: row.topic,
        initiator: row.initiator,
        members: JSON.parse(row.members) as ReadonlyArray<string>,
        open: row.open === 1,
        utterances: utterances.map(
          (utterance): CallUtterance => ({
            seq: utterance.seq,
            author: utterance.author,
            text: utterance.text,
            at: utterance.at,
          }),
        ),
        createdAt: row.created_at,
      } satisfies CallView;
    });

    const broadcast = Effect.fn(function* (id: string) {
      const sockets = yield* state.getWebSockets(TAG);
      if (sockets.length === 0) return;
      const view = yield* viewOf(id);
      if (view === undefined) return;
      const data = JSON.stringify({ type: "call", call: view });
      yield* Effect.forEach(
        sockets,
        (socket) => Effect.ignore(socket.send(data)),
        { discard: true },
      );
    });

    const record = Effect.fn(function* (
      id: string,
      author: string,
      text: string,
    ) {
      const at = yield* Clock.currentTimeMillis;
      yield* sql.exec(
        "INSERT INTO utterances (call_id, seq, author, text, at) VALUES (?, COALESCE((SELECT MAX(seq) FROM utterances WHERE call_id = ?), -1) + 1, ?, ?, ?)",
        id,
        id,
        author,
        text,
        at,
      );
      yield* broadcast(id);
    });

    return Effect.gen(function* () {
      yield* Effect.forEach(
        TABLES,
        (table) =>
          sql.exec(table.trim().replaceAll(/\s+/g, " ")).pipe(Effect.asVoid),
        { discard: true },
      );

      return {
        fetch: Effect.gen(function* () {
          const [response] = yield* Cloudflare.upgrade({ tags: [TAG] });
          return response;
        }),

        webSocketMessage: Effect.fn(
          function* (socket: Cloudflare.WebSocket, message) {
            const id = (JSON.parse(String(message)) as { call?: string }).call;
            if (typeof id !== "string") return;
            const view = yield* viewOf(id);
            if (view === undefined) return;
            yield* Effect.ignore(
              socket.send(JSON.stringify({ type: "call", call: view })),
            );
          },
          Effect.catchDefect((defect) =>
            Effect.logWarning(`[call-socket] bad frame: ${String(defect)}`),
          ),
        ),

        askOpen: Effect.fn(function* (input) {
          const at = yield* Clock.currentTimeMillis;
          yield* sql.exec(
            `INSERT OR IGNORE INTO asks
              (id, parent_id, call_id, asker, target, question, status, at)
             VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`
              .trim()
              .replaceAll(/\s+/g, " "),
            input.id,
            input.parent ?? null,
            input.call ?? null,
            input.asker,
            input.target,
            input.question,
            at,
          );
        }),

        askSettle: Effect.fn(function* (id, status, answer) {
          const at = yield* Clock.currentTimeMillis;
          yield* sql.exec(
            "UPDATE asks SET status = ?, answer = ?, answered_at = ? WHERE id = ?",
            status,
            answer,
            at,
            id,
          );
        }),

        askTree: Effect.fn(function* (id) {
          // the subtree, assembled in memory — chains are hop-budgeted
          // (MAX_HOPS), so a tree is small by construction
          const rows = yield* (yield* sql.exec<AskRow>(
            `WITH RECURSIVE tree (id) AS (
               SELECT ? UNION ALL
               SELECT asks.id FROM asks JOIN tree ON asks.parent_id = tree.id
             )
             SELECT asks.* FROM asks JOIN tree ON asks.id = tree.id
             ORDER BY asks.at ASC`
              .trim()
              .replaceAll(/\s+/g, " "),
            id,
          )).toArray();
          const nodes = new Map<string, AskNode & { children: AskNode[] }>();
          for (const row of rows) {
            nodes.set(row.id, { ...toNode(row), children: [] });
          }
          for (const node of nodes.values()) {
            if (node.parent !== undefined) {
              nodes.get(node.parent)?.children.push(node);
            }
          }
          return nodes.get(id);
        }),

        askRoots: Effect.fn(function* (limit) {
          const rows = yield* (yield* sql.exec<AskRow>(
            "SELECT * FROM asks WHERE parent_id IS NULL ORDER BY at DESC LIMIT ?",
            limit ?? 50,
          )).toArray();
          return rows.map(toNode);
        }),

        open: Effect.fn(function* (input) {
          const at = yield* Clock.currentTimeMillis;
          const id = `c-${at.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          yield* sql.exec(
            "INSERT INTO calls (id, topic, initiator, members, open, created_at) VALUES (?, ?, ?, ?, 1, ?)",
            id,
            input.topic,
            input.initiator,
            JSON.stringify([...new Set([input.initiator, ...input.members])]),
            at,
          );
          yield* record(id, input.initiator, `opened the call: ${input.topic}`);
          return id;
        }),

        append: Effect.fn(function* (id, utterance) {
          yield* record(id, utterance.author, utterance.text);
        }),

        read: Effect.fn(function* (id) {
          return yield* viewOf(id);
        }),

        since: Effect.fn(function* (id, member) {
          const seen = yield* (yield* sql.exec<
            { seen_seq: number } & Record<string, Cloudflare.SqlStorageValue>
          >(
            "SELECT seen_seq FROM watermarks WHERE call_id = ? AND member = ?",
            id,
            member,
          )).toArray();
          const from = seen[0]?.seen_seq ?? -1;
          const rows = yield* (yield* sql.exec<UtteranceRow>(
            "SELECT * FROM utterances WHERE call_id = ? AND seq > ? AND author <> ? ORDER BY seq ASC",
            id,
            from,
            member,
          )).toArray();
          const top = yield* (yield* sql.exec<
            { top: number | null } & Record<string, Cloudflare.SqlStorageValue>
          >(
            "SELECT MAX(seq) AS top FROM utterances WHERE call_id = ?",
            id,
          )).toArray();
          yield* sql.exec(
            "INSERT OR REPLACE INTO watermarks (call_id, member, seen_seq) VALUES (?, ?, ?)",
            id,
            member,
            top[0]?.top ?? from,
          );
          return rows.map(
            (row): CallUtterance => ({
              seq: row.seq,
              author: row.author,
              text: row.text,
              at: row.at,
            }),
          );
        }),
      } satisfies ChatRpc;
    });
  }),
);

/** The ONE chat-store instance's name. */
const MAIN = "main";

/** The {@link Calls} facade over the ChatDO. */
export const CallsLive: Layer.Layer<Calls, never, Cloudflare.Worker> =
  Layer.effect(
    Calls,
    Effect.gen(function* () {
      const namespace = yield* ChatDOLive;
      const stub = () => namespace.getByName(MAIN);
      return Calls.of({
        open: (input) => inWorker(stub().open(input)),
        append: (id, utterance) => inWorker(stub().append(id, utterance)),
        read: (id) => inWorker(stub().read(id)),
        since: (id, member) => inWorker(stub().since(id, member)),
        socket: (_id, request) =>
          inWorker(stub().fetch(request).pipe(Effect.orDie)),
      });
    }),
  );

/** The {@link Asks} facade over the same DO. */
export const AsksLive: Layer.Layer<Asks, never, Cloudflare.Worker> =
  Layer.effect(
    Asks,
    Effect.gen(function* () {
      const namespace = yield* ChatDOLive;
      const stub = () => namespace.getByName(MAIN);
      return Asks.of({
        open: (input) => inWorker(stub().askOpen(input)),
        settle: (id, status, answer) =>
          inWorker(stub().askSettle(id, status, answer)),
        tree: (id) => inWorker(stub().askTree(id)),
        roots: (limit) => inWorker(stub().askRoots(limit)),
      });
    }),
  );
