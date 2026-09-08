import * as Cloudflare from "alchemy/Cloudflare";
import type * as GitHub from "alchemy/GitHub";
import type { MainRpc } from "alchemy/Platform";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  CURSOR_PAGE_LIMIT,
  cursorPage,
  type CursorClientFrame,
  type CursorPage,
  type CursorServerFrame,
} from "../platform/Cursor.ts";
import { inWorker } from "../platform/Database.ts";
import {
  Channel,
  type AppendInput,
  type ChannelCard,
  type ChannelMessage,
  type Delivered,
  type SearchFilter,
  type ThreadDirectoryRow,
} from "./Channel.ts";
import { describeEvent } from "./DescribeEvent.ts";

/**
 * The CHANNEL's Durable Object — ONE instance (`main`) for the whole
 * org. It owns the channel log (dense `seq`, the cursor protocol's
 * spine), the thread directory and `ref → thread` attachment
 * projections the ThreadDOs push, the delivered-hash dedupe that
 * replaced the Ledger, and the hibernatable `/channel` WebSocket
 * fan-out.
 *
 * Everything here is one single-threaded turn per call: `deliver` is
 * one transaction (dedupe row + message row + owner lookup), replay
 * and the switch to live cannot interleave with an append.
 */

const TAG = "channel";

/** What rides the channel socket: the cursor frames + the directory. */
export type ChannelSocketFrame =
  | CursorServerFrame<ChannelMessage>
  | {
      readonly type: "directory";
      readonly rows: ReadonlyArray<ThreadDirectoryRow>;
    }
  | {
      /** Rows the operator deleted — drop them from the view. Their
       *  seqs are retired (never re-minted), so watermarks hold. */
      readonly type: "remove";
      readonly seqs: ReadonlyArray<number>;
    };

const TABLES = [
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL UNIQUE,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    author TEXT,
    text TEXT NOT NULL,
    repo TEXT,
    ref TEXT,
    event TEXT,
    thread TEXT,
    placed INTEGER NOT NULL DEFAULT 0,
    card TEXT,
    reply_to TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS directory (
    thread_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    turn TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS attachments (
    ref TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS delivered (
    key TEXT PRIMARY KEY
  )`,
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

interface MessageRow extends Record<string, Cloudflare.SqlStorageValue> {
  id: string;
  seq: number;
  at: number;
  kind: string;
  author: string | null;
  text: string;
  repo: string | null;
  ref: string | null;
  event: string | null;
  thread: string | null;
  placed: number;
  card: string | null;
  reply_to: string | null;
}

/** Columns added after the table shipped — `CREATE TABLE IF NOT
 *  EXISTS` skips an existing table, so each is ALTERed in when
 *  `PRAGMA table_info` says it is missing. */
const MIGRATIONS: ReadonlyArray<readonly [column: string, ddl: string]> = [
  ["reply_to", "ALTER TABLE messages ADD COLUMN reply_to TEXT"],
];

interface DirectoryRow extends Record<string, Cloudflare.SqlStorageValue> {
  thread_id: string;
  name: string;
  title: string;
  status: string;
  turn: string;
  updated_at: number;
}

const toMessage = (row: MessageRow): ChannelMessage => ({
  id: row.id,
  seq: row.seq,
  at: row.at,
  kind: row.kind as ChannelMessage["kind"],
  author: row.author === null ? undefined : { login: row.author },
  text: row.text,
  ...(row.repo === null ? {} : { repo: row.repo }),
  ...(row.ref === null ? {} : { ref: row.ref }),
  ...(row.event === null ? {} : { event: row.event }),
  ...(row.thread === null ? {} : { thread: row.thread }),
  ...(row.placed === 0 ? {} : { placed: true }),
  ...(row.card === null
    ? {}
    : { card: JSON.parse(row.card) as ChannelCard }),
  ...(row.reply_to === null
    ? {}
    : { replyTo: JSON.parse(row.reply_to) as ReadonlyArray<string> }),
});

const toDirectory = (row: DirectoryRow): ThreadDirectoryRow => ({
  id: row.thread_id,
  name: row.name,
  title: row.title,
  status: row.status as ThreadDirectoryRow["status"],
  turn: row.turn as ThreadDirectoryRow["turn"],
  updatedAt: row.updated_at,
});

/** Ids per `IN (…)` — under SQLite storage's 100-parameter cap. */
const IN_PAGE = 50;

interface ChannelRpc extends MainRpc<Cloudflare.DurableObjectState> {
  readonly deliver: (
    event: GitHub.RepositoryEvent,
  ) => Effect.Effect<Delivered, never, RuntimeContext>;
  readonly append: (
    input: AppendInput,
  ) => Effect.Effect<ChannelMessage, never, RuntimeContext>;
  readonly update: (
    id: string,
    patch: { readonly text?: string; readonly card?: ChannelCard },
  ) => Effect.Effect<ChannelMessage | undefined, never, RuntimeContext>;
  readonly tag: (
    ids: ReadonlyArray<string>,
    thread: string | null,
    placed: boolean,
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly remove: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly page: (options?: {
    readonly after?: number;
    readonly limit?: number;
  }) => Effect.Effect<CursorPage<ChannelMessage>, never, RuntimeContext>;
  readonly search: (
    filter: SearchFilter,
  ) => Effect.Effect<ReadonlyArray<ChannelMessage>, never, RuntimeContext>;
  readonly read: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<ChannelMessage>, never, RuntimeContext>;
  readonly directory: () => Effect.Effect<
    ReadonlyArray<ThreadDirectoryRow>,
    never,
    RuntimeContext
  >;
  readonly directoryUpsert: (
    row: ThreadDirectoryRow,
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly directoryRemove: (
    id: string,
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly attachmentsSet: (
    ref: string,
    thread: string | null,
  ) => Effect.Effect<void, never, RuntimeContext>;
  readonly attachmentOf: (
    ref: string,
  ) => Effect.Effect<string | undefined, never, RuntimeContext>;
  readonly claimBootstrap: () => Effect.Effect<
    boolean,
    never,
    RuntimeContext
  >;
}

const ChannelDOLive = Cloudflare.DurableObject<ChannelRpc>()(
  "ChannelDO",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const sql = state.storage.sql;

    // the constructor also runs at PLAN time against a mock state —
    // tables are ensured lazily, once, on the first call
    const ensured = yield* Effect.cached(
      Effect.gen(function* () {
        yield* Effect.forEach(
          TABLES,
          (table) =>
            sql
              .exec(table.trim().replaceAll(/\s+/g, " "))
              .pipe(Effect.asVoid),
          { discard: true },
        );
        const info = yield* sql.exec<
          { name: string } & Record<string, Cloudflare.SqlStorageValue>
        >("PRAGMA table_info(messages)");
        const columns = new Set((yield* info.toArray()).map((c) => c.name));
        for (const [column, ddl] of MIGRATIONS) {
          if (!columns.has(column)) yield* sql.exec(ddl);
        }
      }),
    );

    // the head is a MONOTONIC counter persisted in meta, not
    // MAX(seq): deleting the tail row must not let the next append
    // re-mint a retired seq (clients watermarked past it would
    // silently miss the new row). MAX(seq) is folded in only to
    // migrate logs written before the counter existed.
    const head = Effect.gen(function* () {
      const cursor = yield* sql.exec<{
        head: number;
      } & Record<string, Cloudflare.SqlStorageValue>>(
        "SELECT COALESCE(MAX(seq), 0) AS head FROM messages",
      );
      const rows = yield* cursor.toArray();
      const maxSeq = rows[0]?.head ?? 0;
      const meta = yield* sql.exec<
        { value: string } & Record<string, Cloudflare.SqlStorageValue>
      >("SELECT value FROM meta WHERE key = 'head'");
      const stored = Number((yield* meta.toArray())[0]?.value ?? 0);
      return Math.max(maxSeq, stored);
    });

    const slice = (after: number, limit: number) =>
      Effect.gen(function* () {
        const cursor = yield* sql.exec<MessageRow>(
          "SELECT * FROM messages WHERE seq > ? ORDER BY seq ASC LIMIT ?",
          after,
          limit,
        );
        return (yield* cursor.toArray()).map(toMessage);
      });

    const byId = (id: string) =>
      Effect.gen(function* () {
        const cursor = yield* sql.exec<MessageRow>(
          "SELECT * FROM messages WHERE id = ?",
          id,
        );
        const rows = yield* cursor.toArray();
        return rows[0] === undefined ? undefined : toMessage(rows[0]);
      });

    const broadcast = (frame: ChannelSocketFrame) =>
      Effect.gen(function* () {
        const sockets = yield* state.getWebSockets(TAG);
        const data = JSON.stringify(frame);
        yield* Effect.forEach(
          sockets,
          (socket) => Effect.ignore(socket.send(data)),
          { discard: true },
        );
      });

    const readDirectory = Effect.gen(function* () {
      const cursor = yield* sql.exec<DirectoryRow>(
        "SELECT * FROM directory ORDER BY updated_at DESC",
      );
      return (yield* cursor.toArray()).map(toDirectory);
    });

    /** Insert one message (idempotent on id); the row as stored. */
    const insert = (input: AppendInput) =>
      Effect.gen(function* () {
        yield* ensured;
        const id = input.id ?? crypto.randomUUID();
        const existing = yield* byId(id);
        if (existing !== undefined) return { message: existing, fresh: false };
        const seq = (yield* head) + 1;
        // advance the monotonic counter WITH the row (same DO turn) —
        // a delete of this row later can never roll the head back
        yield* sql.exec(
          "INSERT OR REPLACE INTO meta (key, value) VALUES ('head', ?)",
          String(seq),
        );
        const at = yield* Clock.currentTimeMillis;
        yield* sql.exec(
          `INSERT INTO messages (id, seq, at, kind, author, text, repo, ref, event, thread, placed, card, reply_to)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            .trim()
            .replaceAll(/\s+/g, " "),
          id,
          seq,
          at,
          input.kind,
          input.author?.login ?? null,
          input.text,
          input.repo ?? null,
          input.ref ?? null,
          input.event ?? null,
          input.thread ?? null,
          0,
          input.card === undefined ? null : JSON.stringify(input.card),
          input.replyTo === undefined || input.replyTo.length === 0
            ? null
            : JSON.stringify(input.replyTo),
        );
        const message = (yield* byId(id))!;
        yield* broadcast({ type: "item", item: message });
        return { message, fresh: true };
      });

    return Effect.succeed<ChannelRpc>({
      /**
       * The `/channel` WebSocket: accept, hibernate freely — there is
       * no in-memory state; `broadcast` re-reads the attached sockets
       * from the runtime every time.
       */
      fetch: Effect.gen(function* () {
        yield* HttpServerRequest;
        const [response] = yield* Cloudflare.upgrade({ tags: [TAG] });
        return response;
      }) as Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        never,
        RuntimeContext | Cloudflare.DurableObjectState
      >,

      /**
       * `subscribe { after }`: replay `after+1 … head` in batches,
       * mark live, then every append arrives as an `item`. The whole
       * handler is one DO turn — an append cannot interleave.
       */
      webSocketMessage: (socket: Cloudflare.WebSocket, message) =>
        Effect.gen(function* () {
          yield* ensured;
          const frame = JSON.parse(
            typeof message === "string"
              ? message
              : new TextDecoder().decode(message),
          ) as CursorClientFrame;
          if (frame.type !== "subscribe") return;
          const send = (out: ChannelSocketFrame) =>
            Effect.ignore(socket.send(JSON.stringify(out)));
          yield* send({ type: "directory", rows: yield* readDirectory });
          const tail = yield* head;
          let after = frame.after;
          while (after < tail) {
            const items = yield* slice(after, CURSOR_PAGE_LIMIT);
            if (items.length === 0) break;
            yield* send({ type: "batch", items, head: tail });
            after = items[items.length - 1]!.seq;
          }
          yield* send({ type: "live", seq: tail });
        }).pipe(
          Effect.catchDefect((defect) =>
            Effect.logWarning(
              `[channel-socket] bad frame: ${String(defect)}`,
            ),
          ),
          (effect) => inWorker(effect),
        ) as Effect.Effect<void>,

      webSocketClose: (socket: Cloudflare.WebSocket, code: number, reason: string) =>
        Effect.gen(function* () {
          const echo = code === 1005 || code === 1006 || code === 1015;
          yield* Effect.ignore(
            socket.close(echo ? 1000 : code, echo ? "" : reason),
          );
        }),

      deliver: (event) =>
        Effect.gen(function* () {
          yield* ensured;
          // dedupe on the delivery's CONTENT — parsed events carry no
          // delivery id; the same JSON is the same delivery (the
          // Ledger keyed the same way)
          const key = JSON.stringify(event);
          const seen = yield* sql.exec<
            { n: number } & Record<string, Cloudflare.SqlStorageValue>
          >("SELECT COUNT(*) AS n FROM delivered WHERE key = ?", key);
          if (((yield* seen.toArray())[0]?.n ?? 0) > 0) {
            return {
              duplicate: true,
              owner: undefined,
              message: undefined,
            } satisfies Delivered;
          }
          yield* sql.exec("INSERT INTO delivered (key) VALUES (?)", key);
          const input = describeEvent(event);
          // an owned ref's event lands pre-tagged with its thread
          const owner =
            input.ref === undefined
              ? undefined
              : yield* Effect.gen(function* () {
                  const cursor = yield* sql.exec<
                    { thread_id: string } & Record<
                      string,
                      Cloudflare.SqlStorageValue
                    >
                  >(
                    "SELECT thread_id FROM attachments WHERE ref = ?",
                    input.ref!,
                  );
                  return (yield* cursor.toArray())[0]?.thread_id;
                });
          const { message } = yield* insert(
            owner === undefined ? input : { ...input, thread: owner },
          );
          return { duplicate: false, owner, message } satisfies Delivered;
        }),

      append: (input) =>
        Effect.gen(function* () {
          return (yield* insert(input)).message;
        }),

      update: (id, patch) =>
        Effect.gen(function* () {
          yield* ensured;
          const current = yield* byId(id);
          if (current === undefined) return undefined;
          yield* sql.exec(
            "UPDATE messages SET text = ?, card = ? WHERE id = ?",
            patch.text ?? current.text,
            patch.card === undefined
              ? current.card === undefined
                ? null
                : JSON.stringify(current.card)
              : JSON.stringify(patch.card),
            id,
          );
          const next = (yield* byId(id))!;
          yield* broadcast({ type: "update", item: next });
          return next;
        }),

      tag: (ids, thread, placed) =>
        Effect.gen(function* () {
          yield* ensured;
          for (const id of ids) {
            yield* sql.exec(
              "UPDATE messages SET thread = ?, placed = ? WHERE id = ?",
              thread,
              placed && thread !== null ? 1 : 0,
              id,
            );
            const next = yield* byId(id);
            if (next !== undefined) {
              yield* broadcast({ type: "update", item: next });
            }
          }
        }),

      remove: (ids) =>
        Effect.gen(function* () {
          yield* ensured;
          const seqs: Array<number> = [];
          for (const id of ids) {
            const current = yield* byId(id);
            if (current === undefined) continue;
            yield* sql.exec("DELETE FROM messages WHERE id = ?", id);
            seqs.push(current.seq);
          }
          if (seqs.length > 0) {
            yield* broadcast({ type: "remove", seqs });
          }
        }),

      page: (options) =>
        Effect.gen(function* () {
          yield* ensured;
          const limit = Math.min(
            options?.limit ?? CURSOR_PAGE_LIMIT,
            CURSOR_PAGE_LIMIT,
          );
          const items = yield* slice(options?.after ?? 0, limit);
          return cursorPage(items, yield* head);
        }),

      search: (filter) =>
        Effect.gen(function* () {
          yield* ensured;
          const where: Array<string> = [];
          const binds: Array<string | number> = [];
          if (filter.q !== undefined && filter.q.length > 0) {
            where.push("text LIKE ? COLLATE NOCASE");
            binds.push(`%${filter.q}%`);
          }
          if (filter.before !== undefined) {
            where.push("seq <= ?");
            binds.push(filter.before);
          }
          if (filter.author !== undefined) {
            where.push("author = ?");
            binds.push(filter.author);
          }
          if (filter.thread !== undefined) {
            where.push("thread = ?");
            binds.push(filter.thread);
          }
          if (filter.kind !== undefined) {
            where.push("kind = ?");
            binds.push(filter.kind);
          }
          const limit = Math.min(filter.limit ?? 50, CURSOR_PAGE_LIMIT);
          const cursor = yield* sql.exec<MessageRow>(
            `SELECT * FROM messages${
              where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""
            } ORDER BY seq DESC LIMIT ${limit}`,
            ...binds,
          );
          return (yield* cursor.toArray()).map(toMessage);
        }),

      read: (ids) =>
        Effect.gen(function* () {
          yield* ensured;
          if (ids.length === 0) return [];
          const found = new Map<string, ChannelMessage>();
          for (let i = 0; i < ids.length; i += IN_PAGE) {
            const page = ids.slice(i, i + IN_PAGE);
            const cursor = yield* sql.exec<MessageRow>(
              `SELECT * FROM messages WHERE id IN (${page.map(() => "?").join(", ")})`,
              ...page,
            );
            for (const row of yield* cursor.toArray()) {
              found.set(row.id, toMessage(row));
            }
          }
          return ids.flatMap((id) => {
            const message = found.get(id);
            return message === undefined ? [] : [message];
          });
        }),

      directory: () =>
        Effect.gen(function* () {
          yield* ensured;
          return yield* readDirectory;
        }),

      directoryUpsert: (row) =>
        Effect.gen(function* () {
          yield* ensured;
          yield* sql.exec(
            `INSERT OR REPLACE INTO directory (thread_id, name, title, status, turn, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`
              .trim()
              .replaceAll(/\s+/g, " "),
            row.id,
            row.name,
            row.title,
            row.status,
            row.turn,
            row.updatedAt,
          );
          yield* broadcast({ type: "directory", rows: yield* readDirectory });
        }),

      directoryRemove: (id) =>
        Effect.gen(function* () {
          yield* ensured;
          yield* sql.exec("DELETE FROM directory WHERE thread_id = ?", id);
          // a deleted thread owns nothing — its refs are free again
          yield* sql.exec("DELETE FROM attachments WHERE thread_id = ?", id);
          yield* broadcast({ type: "directory", rows: yield* readDirectory });
        }),

      attachmentsSet: (ref, thread) =>
        Effect.gen(function* () {
          yield* ensured;
          if (thread === null) {
            yield* sql.exec("DELETE FROM attachments WHERE ref = ?", ref);
          } else {
            yield* sql.exec(
              "INSERT OR REPLACE INTO attachments (ref, thread_id) VALUES (?, ?)",
              ref,
              thread,
            );
          }
        }),

      attachmentOf: (ref) =>
        Effect.gen(function* () {
          yield* ensured;
          const cursor = yield* sql.exec<
            { thread_id: string } & Record<string, Cloudflare.SqlStorageValue>
          >("SELECT thread_id FROM attachments WHERE ref = ?", ref);
          return (yield* cursor.toArray())[0]?.thread_id;
        }),

      claimBootstrap: () =>
        Effect.gen(function* () {
          yield* ensured;
          const cursor = yield* sql.exec<
            { n: number } & Record<string, Cloudflare.SqlStorageValue>
          >("SELECT COUNT(*) AS n FROM meta WHERE key = 'bootstrapped'");
          if (((yield* cursor.toArray())[0]?.n ?? 0) > 0) return false;
          yield* sql.exec(
            "INSERT INTO meta (key, value) VALUES ('bootstrapped', '1')",
          );
          return true;
        }),
    });
  }),
);

/** The ONE channel instance's name. */
const MAIN = "main";

/**
 * The {@link Channel} facade over the one ChannelDO. Requires the host
 * `Worker`: yielding the Durable Object while this Layer builds is
 * what declares it as a binding of the Worker whose bundle carries its
 * class.
 */
export const ChannelLive: Layer.Layer<Channel, never, Cloudflare.Worker> =
  Layer.effect(
    Channel,
    Effect.gen(function* () {
      const namespace = yield* ChannelDOLive;
      const stub = () => namespace.getByName(MAIN);
      return Channel.of({
        deliver: (event) => inWorker(stub().deliver(event)),
        append: (input) => inWorker(stub().append(input)),
        update: (id, patch) => inWorker(stub().update(id, patch)),
        tag: (ids, thread, placed) =>
          inWorker(stub().tag(ids, thread, placed)),
        remove: (ids) => inWorker(stub().remove(ids)),
        page: (options) => inWorker(stub().page(options)),
        search: (filter) => inWorker(stub().search(filter)),
        read: (ids) => inWorker(stub().read(ids)),
        directory: () => inWorker(stub().directory()),
        directoryUpsert: (row) => inWorker(stub().directoryUpsert(row)),
        directoryRemove: (id) => inWorker(stub().directoryRemove(id)),
        attachmentsSet: (ref, thread) =>
          inWorker(stub().attachmentsSet(ref, thread)),
        attachmentOf: (ref) => inWorker(stub().attachmentOf(ref)),
        claimBootstrap: () => inWorker(stub().claimBootstrap()),
        socket: (request) =>
          inWorker(stub().fetch(request).pipe(Effect.orDie)),
      });
    }),
  );
