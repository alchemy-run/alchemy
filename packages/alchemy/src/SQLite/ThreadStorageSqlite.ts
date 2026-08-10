/**
 * `AI.ThreadStorage` over bun:sqlite — the durable LOCAL substrate:
 *
 * ```ts
 * AI.DriverLocal.pipe(
 *   Layer.provide(ThreadStorageSqlite(".alchemy/runs.sqlite")),
 * )
 * ```
 *
 * Every thread row, inbox row, observation, and meta write lands in
 * sqlite the moment it happens (the engine is write-through), so a
 * killed process loses nothing: restart restores every unsettled
 * session parked, thread primed, observation cursor continued, and —
 * because the inbox and the round liveness marker are durable too —
 * inputs that arrived before the crash redeliver and interrupted
 * rounds recover exactly as they do on Durable Objects.
 *
 * The atomic pairs (admit = messages + watermark + meta; observation
 * + cursor) are transactions. Same sqlite physics as the sibling
 * stores: no finalizer, the OS closes the fd at exit. `bun:sqlite` is
 * imported lazily inside the layer build so this module stays
 * bundleable outside bun.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Prompt from "effect/unstable/ai/Prompt";
import type { SessionObservation } from "../AI/EventStream.ts";
import {
  ThreadStorage,
  type InboxRow,
  type SessionMeta,
  type ThreadHandle,
} from "../AI/ThreadStorage.ts";

const TABLES = `
CREATE TABLE IF NOT EXISTS session_meta (
  term      TEXT NOT NULL,
  key       TEXT NOT NULL,
  data      TEXT NOT NULL,
  drained   INTEGER NOT NULL DEFAULT 0,
  inbox_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (term, key)
);
CREATE TABLE IF NOT EXISTS session_messages (
  term TEXT NOT NULL,
  key  TEXT NOT NULL,
  seq  INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (term, key, seq)
);
CREATE TABLE IF NOT EXISTS session_inbox (
  term  TEXT NOT NULL,
  key   TEXT NOT NULL,
  seq   INTEGER NOT NULL,
  data  TEXT NOT NULL,
  quiet INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (term, key, seq)
);
CREATE TABLE IF NOT EXISTS session_observations (
  term TEXT NOT NULL,
  key  TEXT NOT NULL,
  seq  INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (term, key, seq)
);`;

export const ThreadStorageSqlite = (path: string): Layer.Layer<ThreadStorage> =>
  Layer.effect(
    ThreadStorage,
    Effect.gen(function* () {
      const { Database } = yield* Effect.promise(() => import("bun:sqlite"));
      const db = yield* Effect.try({
        try: () => {
          const database = new Database(path, { create: true });
          database.run("PRAGMA journal_mode = WAL;");
          database.run("PRAGMA busy_timeout = 30000;");
          database.run(TABLES);
          return database;
        },
        catch: (cause) =>
          new Error(`ThreadStorageSqlite failed to open ${path}: ${cause}`),
      }).pipe(Effect.orDie);

      return ThreadStorage.of({
        open: (term, key) =>
          Effect.sync((): ThreadHandle => {
            /** The meta row is the session's anchor: inbox and admit
             *  bookkeeping live on it, so ensure it exists. */
            const ensureRow = () => {
              db.query(
                "INSERT OR IGNORE INTO session_meta (term, key, data) VALUES (?, ?, 'null')",
              ).run(term, key);
            };
            const readRow = () =>
              db
                .query(
                  "SELECT data, drained, inbox_seq FROM session_meta WHERE term = ? AND key = ?",
                )
                .get(term, key) as {
                data: string;
                drained: number;
                inbox_seq: number;
              } | null;
            const putMeta = (meta: SessionMeta) => {
              ensureRow();
              db.query(
                "UPDATE session_meta SET data = ? WHERE term = ? AND key = ?",
              ).run(JSON.stringify(meta), term, key);
            };
            const nextMessageSeq = () =>
              (
                db
                  .query(
                    "SELECT COALESCE(MAX(seq) + 1, 0) AS seq FROM session_messages WHERE term = ? AND key = ?",
                  )
                  .get(term, key) as { seq: number }
              ).seq;
            const insertMessages = (
              messages: ReadonlyArray<Prompt.MessageEncoded>,
            ) => {
              let seq = nextMessageSeq();
              const insert = db.query(
                "INSERT INTO session_messages (term, key, seq, data) VALUES (?, ?, ?, ?)",
              );
              for (const message of messages) {
                insert.run(term, key, seq++, JSON.stringify(message));
              }
            };
            return {
              meta: Effect.sync(() => {
                const found = readRow();
                if (found === null) return undefined;
                return (
                  (JSON.parse(found.data) as SessionMeta | null) ?? undefined
                );
              }),
              putMeta: (meta) => Effect.sync(() => putMeta(meta)),
              putInbox: (input, inboxOptions) =>
                Effect.sync(() =>
                  db.transaction(() => {
                    ensureRow();
                    const seq = (readRow()?.inbox_seq ?? 0) as number;
                    db.query(
                      "INSERT INTO session_inbox (term, key, seq, data, quiet) VALUES (?, ?, ?, ?, ?)",
                    ).run(
                      term,
                      key,
                      seq,
                      JSON.stringify(input ?? null),
                      inboxOptions?.quiet === true ? 1 : 0,
                    );
                    db.query(
                      "UPDATE session_meta SET inbox_seq = ? WHERE term = ? AND key = ?",
                    ).run(seq + 1, term, key);
                    return seq;
                  })(),
                ),
              listInbox: Effect.sync(() => {
                const drained = readRow()?.drained ?? 0;
                return (
                  db
                    .query(
                      "SELECT seq, data, quiet FROM session_inbox WHERE term = ? AND key = ? AND seq >= ? ORDER BY seq",
                    )
                    .all(term, key, drained) as Array<{
                    seq: number;
                    data: string;
                    quiet: number;
                  }>
                ).map(
                  (inboxRow): InboxRow => ({
                    seq: inboxRow.seq,
                    input: JSON.parse(inboxRow.data),
                    quiet: inboxRow.quiet === 1,
                  }),
                );
              }),
              deleteInbox: (seqs) =>
                Effect.sync(() => {
                  const drop = db.query(
                    "DELETE FROM session_inbox WHERE term = ? AND key = ? AND seq = ?",
                  );
                  for (const seq of seqs) drop.run(term, key, seq);
                }),
              // the crash-consistency heart: messages + watermark +
              // meta in ONE transaction
              admit: ({ messages, drainedTo, meta }) =>
                Effect.sync(() => {
                  db.transaction(() => {
                    ensureRow();
                    insertMessages(messages);
                    db.query(
                      "UPDATE session_meta SET data = ?, drained = ? WHERE term = ? AND key = ?",
                    ).run(JSON.stringify(meta), drainedTo, term, key);
                  })();
                }),
              messages: Effect.sync(
                () =>
                  (
                    db
                      .query(
                        "SELECT data FROM session_messages WHERE term = ? AND key = ? ORDER BY seq",
                      )
                      .all(term, key) as Array<{ data: string }>
                  ).map(
                    (row) => JSON.parse(row.data) as Prompt.MessageEncoded,
                  ) as ReadonlyArray<Prompt.MessageEncoded>,
              ),
              appendMessages: (messages) =>
                Effect.sync(() => {
                  if (messages.length === 0) return;
                  db.transaction(() => insertMessages(messages))();
                }),
              replaceMessages: (messages) =>
                Effect.sync(() => {
                  db.transaction(() => {
                    db.query(
                      "DELETE FROM session_messages WHERE term = ? AND key = ?",
                    ).run(term, key);
                    insertMessages(messages);
                  })();
                }),
              // the row and its cursor land in ONE transaction: a
              // restored session can never re-issue a used seq
              appendObservation: (observation, meta) =>
                Effect.sync(() => {
                  db.transaction(() => {
                    db.query(
                      "INSERT OR REPLACE INTO session_observations (term, key, seq, data) VALUES (?, ?, ?, ?)",
                    ).run(
                      term,
                      key,
                      observation.seq,
                      JSON.stringify(observation),
                    );
                    putMeta(meta);
                  })();
                }),
              observations: (fromSeq) =>
                Effect.sync(
                  () =>
                    (
                      db
                        .query(
                          "SELECT data FROM session_observations WHERE term = ? AND key = ? AND seq >= ? ORDER BY seq",
                        )
                        .all(term, key, fromSeq) as Array<{ data: string }>
                    ).map(
                      (row) => JSON.parse(row.data) as SessionObservation,
                    ) as ReadonlyArray<SessionObservation>,
                ),
            };
          }),
        keys: (term) =>
          Effect.sync(() =>
            (
              db
                .query("SELECT key, data FROM session_meta WHERE term = ?")
                .all(term) as Array<{ key: string; data: string }>
            )
              .filter((row) => row.data !== "null")
              .map((row) => row.key),
          ),
        remove: (term, key) =>
          Effect.sync(() => {
            db.transaction(() => {
              for (const table of [
                "session_meta",
                "session_messages",
                "session_inbox",
                "session_observations",
              ]) {
                db.query(`DELETE FROM ${table} WHERE term = ? AND key = ?`).run(
                  term,
                  key,
                );
              }
            })();
          }),
      });
    }),
  );
