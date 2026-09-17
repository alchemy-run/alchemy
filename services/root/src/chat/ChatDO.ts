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
    reply_to TEXT,
    channel TEXT,
    author TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'message',
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    answering TEXT,
    at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS posts_reply ON posts (reply_to)`,
  `CREATE INDEX IF NOT EXISTS posts_channel ON posts (channel)`,
  `CREATE TABLE IF NOT EXISTS thread_workspaces (
    thread TEXT NOT NULL,
    workspace TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (thread, workspace)
  )`,
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
  reply_to: string | null;
  channel: string | null;
  author: string;
  kind: string;
  text: string;
  status: string;
  answering: string | null;
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
  ...(row.reply_to === null ? {} : { replyTo: row.reply_to }),
  ...(row.channel === null ? {} : { channel: row.channel }),
  author: row.author,
  kind: row.kind === "ask" ? "ask" : "message",
  text: row.text,
  status: row.status as Post["status"],
  ...(row.answering === null || row.answering === undefined
    ? {}
    : { answering: row.answering }),
  at: row.at,
});

interface ChatRpc extends MainRpc<Cloudflare.DurableObjectState> {
  // ── the post stream ──
  readonly postWrite: (input: {
    readonly id: string;
    readonly replyTo?: string;
    readonly channel?: string;
    readonly author: string;
    readonly kind?: Post["kind"];
    readonly text: string;
    readonly status?: Post["status"];
    readonly answering?: string;
  }) => Effect.Effect<void, never, RuntimeContext>;
  readonly postSettle: (
    id: string,
    status: Post["status"],
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly postGet: (
    id: string,
  ) => Effect.Effect<Post | undefined, never, RuntimeContext>;
  /** The messages replying to one post, oldest first. */
  readonly postReplies: (
    id: string,
  ) => Effect.Effect<ReadonlyArray<Post>, never, RuntimeContext>;
  /** The `replyTo` chain ABOVE one post — full messages, oldest
   *  first, ending with the post. */
  readonly postAncestors: (
    id: string,
  ) => Effect.Effect<ReadonlyArray<Post>, never, RuntimeContext>;
  /** The whole THREAD a post lives in: its root's reply graph,
   *  chronological (the root is the first row). */
  readonly postThread: (
    id: string,
  ) => Effect.Effect<ReadonlyArray<Post>, never, RuntimeContext>;
  /** Workspace ↔ thread links — which workspaces are ACTIVE in a
   *  thread. Agents create workspaces as they need them; creating one
   *  inside a thread links it, and any agent can query the thread's
   *  active set. */
  readonly workspaceLink: (
    thread: string,
    workspace: string,
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly workspacesOf: (
    thread: string,
  ) => Effect.Effect<ReadonlyArray<string>, never, RuntimeContext>;
  /** Unlink a dropped workspace everywhere. */
  readonly workspaceUnlink: (
    workspace: string,
  ) => Effect.Effect<void, never, RuntimeContext>;
  /** The stream, oldest first — one channel's feed when `channel` is
   *  given; `limit` keeps the newest messages. */
  readonly postList: (options?: {
    readonly channel?: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<Post>, never, RuntimeContext>;

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
        utterances: utterances.map((utterance): CallUtterance => ({
          seq: utterance.seq,
          author: utterance.author,
          text: utterance.text,
          at: utterance.at,
        })),
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
      // posts written under earlier schemas — PRAGMA-guarded so a
      // re-run never throws duplicate-column and poisons the DO
      const columns = yield* (yield* sql.exec<
        { name: string } & Record<string, Cloudflare.SqlStorageValue>
      >("SELECT name FROM pragma_table_info('posts')")).toArray();
      if (!columns.some((column) => column.name === "channel")) {
        yield* sql.exec("ALTER TABLE posts ADD COLUMN channel TEXT");
      }
      if (!columns.some((column) => column.name === "kind")) {
        yield* sql.exec(
          "ALTER TABLE posts ADD COLUMN kind TEXT NOT NULL DEFAULT 'message'",
        );
      }
      if (!columns.some((column) => column.name === "reply_to")) {
        yield* sql.exec("ALTER TABLE posts ADD COLUMN reply_to TEXT");
      }
      if (!columns.some((column) => column.name === "answering")) {
        yield* sql.exec("ALTER TABLE posts ADD COLUMN answering TEXT");
      }

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
              (id, reply_to, channel, author, kind, text, status, answering, at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
              .trim()
              .replaceAll(/\s+/g, " "),
            input.id,
            input.replyTo ?? null,
            input.channel ?? null,
            input.author,
            input.kind ?? "message",
            input.text,
            input.status ?? "running",
            input.answering ?? null,
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

        postGet: Effect.fn(function* (id) {
          const rows = yield* (yield* sql.exec<PostRow>(
            "SELECT * FROM posts WHERE id = ?",
            id,
          )).toArray();
          return rows[0] === undefined ? undefined : toPost(rows[0]);
        }),

        postReplies: Effect.fn(function* (id) {
          const rows = yield* (yield* sql.exec<PostRow>(
            "SELECT * FROM posts WHERE reply_to = ? ORDER BY at ASC",
            id,
          )).toArray();
          return rows.map(toPost);
        }),

        postAncestors: Effect.fn(function* (id) {
          const rows = yield* (yield* sql.exec<PostRow>(
            `WITH RECURSIVE chain (id, depth) AS (
               SELECT ?, 0 UNION ALL
               SELECT posts.reply_to, chain.depth + 1
               FROM posts JOIN chain ON posts.id = chain.id
               WHERE posts.reply_to IS NOT NULL AND chain.depth < 32
             )
             SELECT posts.* FROM posts JOIN chain ON posts.id = chain.id
             ORDER BY chain.depth DESC`
              .trim()
              .replaceAll(/\s+/g, " "),
            id,
          )).toArray();
          return rows.map(toPost);
        }),

        postThread: Effect.fn(function* (id) {
          // the thread's ROOT: walk the reply chain up…
          const up = yield* (yield* sql.exec<PostRow>(
            `WITH RECURSIVE chain (id, depth) AS (
               SELECT ?, 0 UNION ALL
               SELECT posts.reply_to, chain.depth + 1
               FROM posts JOIN chain ON posts.id = chain.id
               WHERE posts.reply_to IS NOT NULL AND chain.depth < 32
             )
             SELECT posts.* FROM posts JOIN chain ON posts.id = chain.id
             ORDER BY chain.depth DESC LIMIT 1`
              .trim()
              .replaceAll(/\s+/g, " "),
            id,
          )).toArray();
          const root = up[0];
          if (root === undefined) return [];
          // …then the whole reply graph beneath it, chronological
          const rows = yield* (yield* sql.exec<PostRow>(
            `WITH RECURSIVE tree (id) AS (
               SELECT ? UNION ALL
               SELECT posts.id FROM posts JOIN tree ON posts.reply_to = tree.id
             )
             SELECT posts.* FROM posts JOIN tree ON posts.id = tree.id
             ORDER BY posts.at ASC, posts.id ASC LIMIT 200`
              .trim()
              .replaceAll(/\s+/g, " "),
            root.id,
          )).toArray();
          return rows.map(toPost);
        }),

        workspaceLink: Effect.fn(function* (thread, workspace) {
          const at = yield* Clock.currentTimeMillis;
          yield* sql.exec(
            "INSERT INTO thread_workspaces (thread, workspace, at) VALUES (?, ?, ?) ON CONFLICT (thread, workspace) DO NOTHING",
            thread,
            workspace,
            at,
          );
        }),

        workspacesOf: Effect.fn(function* (thread) {
          const rows = yield* (yield* sql.exec<
            { workspace: string } & Record<string, Cloudflare.SqlStorageValue>
          >(
            "SELECT workspace FROM thread_workspaces WHERE thread = ? ORDER BY at ASC",
            thread,
          )).toArray();
          return rows.map((row) => row.workspace);
        }),

        workspaceUnlink: Effect.fn(function* (workspace) {
          yield* sql.exec(
            "DELETE FROM thread_workspaces WHERE workspace = ?",
            workspace,
          );
        }),

        postList: Effect.fn(function* (options) {
          // newest LIMIT rows, then oldest-first for reading order
          const rows = yield* (yield* options?.channel === undefined
            ? sql.exec<PostRow>(
                "SELECT * FROM posts ORDER BY at DESC, id DESC LIMIT ?",
                options?.limit ?? 200,
              )
            : sql.exec<PostRow>(
                "SELECT * FROM posts WHERE channel = ? ORDER BY at DESC, id DESC LIMIT ?",
                options.channel,
                options.limit ?? 200,
              )).toArray();
          return rows.reverse().map(toPost);
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
          return rows.map((row): CallUtterance => ({
            seq: row.seq,
            author: row.author,
            text: row.text,
            at: row.at,
          }));
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
        get: (id) => inWorker(stub().postGet(id)),
        replies: (id) => inWorker(stub().postReplies(id)),
        ancestors: (id) => inWorker(stub().postAncestors(id)),
        thread: (id) => inWorker(stub().postThread(id)),
        list: (options) => inWorker(stub().postList(options)),
        linkWorkspace: (thread, workspace) =>
          inWorker(stub().workspaceLink(thread, workspace)),
        workspacesOf: (thread) => inWorker(stub().workspacesOf(thread)),
        unlinkWorkspace: (workspace) =>
          inWorker(stub().workspaceUnlink(workspace)),
      });
    }),
  );
