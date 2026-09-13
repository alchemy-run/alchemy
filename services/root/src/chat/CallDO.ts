import * as Cloudflare from "alchemy/Cloudflare";
import type { MainRpc } from "alchemy/Platform";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { inWorker } from "../platform/Database.ts";
import { Calls, type CallUtterance, type CallView } from "./Call.ts";

/**
 * The CALLS' Durable Object — ONE instance (`main`) holding every
 * call's transcript and membership. Small state; each call's live view
 * rides a hibernatable WebSocket tagged with the call id (a snapshot on
 * subscribe, a fresh snapshot after every utterance).
 */

const TAG = "calls";

const TABLES = [
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
];

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

interface CallsRpc extends MainRpc<Cloudflare.DurableObjectState> {
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
  readonly close: (
    id: string,
    summary: string,
  ) => Effect.Effect<void, never, RuntimeContext>;
}

const CallDOLive = Cloudflare.DurableObject<CallsRpc>()(
  "CallDO",
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

    // every watcher gets every call's frames (frames carry the call
    // id; the viewer filters) — calls are few and small
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
        `INSERT INTO utterances (call_id, seq, author, text, at)
         VALUES (?, COALESCE((SELECT MAX(seq) FROM utterances WHERE call_id = ?), -1) + 1, ?, ?, ?)`
          .trim()
          .replaceAll(/\s+/g, " "),
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
        /** `/api/calls/:id/live` — a snapshot on subscribe (the client
         *  sends `{"call": id}` as its first message), a fresh snapshot
         *  after every utterance. */
        fetch: Effect.gen(function* () {
          const [response] = yield* Cloudflare.upgrade({ tags: [TAG] });
          return response;
        }),

        webSocketMessage: Effect.fn(
          function* (socket: Cloudflare.WebSocket, message) {
            const id = (
              JSON.parse(String(message)) as { call?: string }
            ).call;
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

        open: Effect.fn(function* (input) {
          const at = yield* Clock.currentTimeMillis;
          const id = `c-${at.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          yield* sql.exec(
            "INSERT INTO calls (id, topic, initiator, members, open, created_at) VALUES (?, ?, ?, ?, 1, ?)",
            id,
            input.topic,
            input.initiator,
            JSON.stringify([
              ...new Set([input.initiator, ...input.members]),
            ]),
            at,
          );
          yield* record(
            id,
            input.initiator,
            `opened the call: ${input.topic}`,
          );
          return id;
        }),

        append: Effect.fn(function* (id, utterance) {
          yield* record(id, utterance.author, utterance.text);
        }),

        read: Effect.fn(function* (id) {
          return yield* viewOf(id);
        }),

        close: Effect.fn(function* (id, summary) {
          yield* sql.exec("UPDATE calls SET open = 0 WHERE id = ?", id);
          yield* record(id, "—", `call closed: ${summary}`);
        }),
      } satisfies CallsRpc;
    });
  }),
);

/** The ONE calls instance's name. */
const MAIN = "main";

/** The {@link Calls} facade over the one CallDO. */
export const CallsLive: Layer.Layer<Calls, never, Cloudflare.Worker> =
  Layer.effect(
    Calls,
    Effect.gen(function* () {
      const namespace = yield* CallDOLive;
      const stub = () => namespace.getByName(MAIN);
      return Calls.of({
        open: (input) => inWorker(stub().open(input)),
        append: (id, utterance) => inWorker(stub().append(id, utterance)),
        read: (id) => inWorker(stub().read(id)),
        close: (id, summary) => inWorker(stub().close(id, summary)),
        socket: (_id, request) =>
          inWorker(stub().fetch(request).pipe(Effect.orDie)),
      });
    }),
  );
