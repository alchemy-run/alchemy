/**
 * `AI.ThreadStorage` over bun:sqlite — the durable LOCAL substrate:
 *
 * ```ts
 * AI.DriverCore.pipe(
 *   Layer.provide(SqliteThreadStorage(".alchemy/sessions.sqlite")),
 * )
 * ```
 *
 * Every thread row, observation, and meta write lands in sqlite the
 * moment it happens (the driver is write-through), so a killed
 * process loses nothing: restart restores every unsettled session PARKED
 * with its thread primed and its observation cursor continued.
 *
 * Same sqlite physics as the sibling stores: no finalizer, commits
 * per statement (observation + meta pair in one transaction), the OS
 * closes the fd at exit. `bun:sqlite` is imported lazily inside the
 * layer build so this module stays bundleable outside bun.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Prompt from "effect/unstable/ai/Prompt";
import type { SessionObservation } from "../AI/Observer.ts";
import {
  ThreadStorage,
  type SessionMeta,
  type ThreadHandle,
} from "../AI/ThreadStorage.ts";

const TABLES = `
CREATE TABLE IF NOT EXISTS session_meta (
  term TEXT NOT NULL,
  key  TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (term, key)
);
CREATE TABLE IF NOT EXISTS session_messages (
  term TEXT NOT NULL,
  key  TEXT NOT NULL,
  seq  INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (term, key, seq)
);
CREATE TABLE IF NOT EXISTS session_observations (
  term TEXT NOT NULL,
  key  TEXT NOT NULL,
  seq  INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (term, key, seq)
);`;

export const SqliteThreadStorage = (path: string): Layer.Layer<ThreadStorage> =>
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
          new Error(`SqliteThreadStorage failed to open ${path}: ${cause}`),
      }).pipe(Effect.orDie);

      return ThreadStorage.of({
        open: (term, key) =>
          Effect.sync((): ThreadHandle => {
            const nextMessageSeq = () =>
              (
                db
                  .query(
                    "SELECT COALESCE(MAX(seq) + 1, 0) AS seq FROM session_messages WHERE term = ? AND key = ?",
                  )
                  .get(term, key) as { seq: number }
              ).seq;
            const putMeta = (meta: SessionMeta) => {
              db.query(
                "INSERT OR REPLACE INTO session_meta (term, key, data) VALUES (?, ?, ?)",
              ).run(term, key, JSON.stringify(meta));
            };
            return {
              meta: Effect.sync(() => {
                const row = db
                  .query(
                    "SELECT data FROM session_meta WHERE term = ? AND key = ?",
                  )
                  .get(term, key) as { data: string } | null;
                return row === null
                  ? undefined
                  : (JSON.parse(row.data) as SessionMeta);
              }),
              putMeta: (meta) => Effect.sync(() => putMeta(meta)),
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
                  db.transaction(() => {
                    let seq = nextMessageSeq();
                    const insert = db.query(
                      "INSERT INTO session_messages (term, key, seq, data) VALUES (?, ?, ?, ?)",
                    );
                    for (const message of messages) {
                      insert.run(term, key, seq++, JSON.stringify(message));
                    }
                  })();
                }),
              replaceMessages: (messages) =>
                Effect.sync(() => {
                  db.transaction(() => {
                    db.query(
                      "DELETE FROM session_messages WHERE term = ? AND key = ?",
                    ).run(term, key);
                    const insert = db.query(
                      "INSERT INTO session_messages (term, key, seq, data) VALUES (?, ?, ?, ?)",
                    );
                    let seq = 0;
                    for (const message of messages) {
                      insert.run(term, key, seq++, JSON.stringify(message));
                    }
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
                .query("SELECT key FROM session_meta WHERE term = ?")
                .all(term) as Array<{ key: string }>
            ).map((row) => row.key),
          ),
        remove: (term, key) =>
          Effect.sync(() => {
            db.transaction(() => {
              db.query(
                "DELETE FROM session_meta WHERE term = ? AND key = ?",
              ).run(term, key);
              db.query(
                "DELETE FROM session_messages WHERE term = ? AND key = ?",
              ).run(term, key);
              db.query(
                "DELETE FROM session_observations WHERE term = ? AND key = ?",
              ).run(term, key);
            })();
          }),
      });
    }),
  );
