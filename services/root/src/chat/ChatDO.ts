import * as Cloudflare from "alchemy/Cloudflare";
import type { MainRpc } from "alchemy/Platform";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { inWorker } from "../platform/Database.ts";
import { Posts, type Post } from "./Posts.ts";
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
  `CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS posts_parent ON posts (parent_id)`,
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

interface PostRow extends Record<string, Cloudflare.SqlStorageValue> {
  id: string;
  parent_id: string | null;
  author: string;
  text: string;
  status: string;
  at: number;
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

const toPost = (row: PostRow): Post => ({
  id: row.id,
  ...(row.parent_id === null ? {} : { parent: row.parent_id }),
  author: row.author,
  text: row.text,
  status: row.status as Post["status"],
  at: row.at,
  children: [],
});

interface ChatRpc extends MainRpc<Cloudflare.DurableObjectState> {
  // ── the post tree ──
  readonly postWrite: (input: {
    readonly id: string;
    readonly parent?: string;
    readonly author: string;
    readonly text: string;
    readonly status?: Post["status"];
  }) => Effect.Effect<void, never, RuntimeContext>;
  readonly postSettle: (
    id: string,
    status: Post["status"],
  ) => Effect.Effect<void, never, RuntimeContext>;
  /** The SUBTREE under one post (children nested, chronological). */
  readonly postTree: (
    id: string,
  ) => Effect.Effect<Post | undefined, never, RuntimeContext>;
  /** The chain ABOVE one post — root first, ending with the post. */
  readonly postAncestors: (
    id: string,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly id: string; readonly author: string }>,
    never,
    RuntimeContext
  >;
  /** Root posts (no parent), newest first — the company's activity. */
  readonly postRoots: (
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<Post>, never, RuntimeContext>;

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

        postWrite: Effect.fn(function* (input) {
          const at = yield* Clock.currentTimeMillis;
          yield* sql.exec(
            `INSERT OR IGNORE INTO posts
              (id, parent_id, author, text, status, at)
             VALUES (?, ?, ?, ?, ?, ?)`
              .trim()
              .replaceAll(/\s+/g, " "),
            input.id,
            input.parent ?? null,
            input.author,
            input.text,
            input.status ?? "running",
            at,
          );
        }),

        postSettle: Effect.fn(function* (id, status) {
          yield* sql.exec(
            "UPDATE posts SET status = ? WHERE id = ?",
            status,
            id,
          );
        }),

        postTree: Effect.fn(function* (id) {
          // the subtree, assembled in memory — chains are hop-budgeted
          // (MAX_HOPS), so a tree is small by construction
          const rows = yield* (yield* sql.exec<PostRow>(
            `WITH RECURSIVE tree (id) AS (
               SELECT ? UNION ALL
               SELECT posts.id FROM posts JOIN tree ON posts.parent_id = tree.id
             )
             SELECT posts.* FROM posts JOIN tree ON posts.id = tree.id
             ORDER BY posts.at ASC`
              .trim()
              .replaceAll(/\s+/g, " "),
            id,
          )).toArray();
          const nodes = new Map<string, Post & { children: Post[] }>();
          for (const row of rows) {
            nodes.set(row.id, { ...toPost(row), children: [] });
          }
          for (const node of nodes.values()) {
            if (node.parent !== undefined) {
              nodes.get(node.parent)?.children.push(node);
            }
          }
          return nodes.get(id);
        }),

        postAncestors: Effect.fn(function* (id) {
          const rows = yield* (yield* sql.exec<PostRow>(
            `WITH RECURSIVE chain (id, depth) AS (
               SELECT ?, 0 UNION ALL
               SELECT posts.parent_id, chain.depth + 1
               FROM posts JOIN chain ON posts.id = chain.id
               WHERE posts.parent_id IS NOT NULL AND chain.depth < 32
             )
             SELECT posts.* FROM posts JOIN chain ON posts.id = chain.id
             ORDER BY chain.depth DESC`
              .trim()
              .replaceAll(/\s+/g, " "),
            id,
          )).toArray();
          return rows.map((row) => ({ id: row.id, author: row.author }));
        }),

        postRoots: Effect.fn(function* (limit) {
          const rows = yield* (yield* sql.exec<PostRow>(
            "SELECT * FROM posts WHERE parent_id IS NULL ORDER BY at DESC LIMIT ?",
            limit ?? 50,
          )).toArray();
          return rows.map(toPost);
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

/** The {@link Posts} facade over the same DO. */
export const PostsLive: Layer.Layer<Posts, never, Cloudflare.Worker> =
  Layer.effect(
    Posts,
    Effect.gen(function* () {
      const namespace = yield* ChatDOLive;
      const stub = () => namespace.getByName(MAIN);
      return Posts.of({
        post: (input) => inWorker(stub().postWrite(input)),
        settle: (id, status) => inWorker(stub().postSettle(id, status)),
        tree: (id) => inWorker(stub().postTree(id)),
        ancestors: (id) => inWorker(stub().postAncestors(id)),
        roots: (limit) => inWorker(stub().postRoots(limit)),
      });
    }),
  );
