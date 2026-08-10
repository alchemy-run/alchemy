import { Database as SqliteDatabase } from "bun:sqlite";
import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const TABLE = `
CREATE TABLE IF NOT EXISTS session_index (
  id          TEXT PRIMARY KEY,
  term        TEXT NOT NULL,
  key         TEXT NOT NULL,
  status      TEXT NOT NULL,
  ticks       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  parent      TEXT,
  first_input TEXT
)`;

/**
 * `AI.SessionIndex` over bun:sqlite — the board survives restarts.
 * Summaries ONLY: transcripts live in the session's own
 * `ThreadStorage`; the live tail rides its socket. Same sqlite
 * physics as the sibling stores: no finalizer, commits per statement,
 * the OS closes the fd at exit.
 */
export const SessionIndexSqlite = (
  path: string,
): Layer.Layer<AI.SessionIndex> =>
  Layer.effect(
    AI.SessionIndex,
    Effect.gen(function* () {
      const db = yield* Effect.try({
        try: () => {
          const database = new SqliteDatabase(path, { create: true });
          database.run(TABLE);
          return database;
        },
        catch: (cause) =>
          new Error(`SessionIndexSqlite failed to open ${path}: ${cause}`),
      }).pipe(Effect.orDie);

      return AI.SessionIndex.of({
        ingest: (observation) =>
          Effect.sync(() => {
            const id = AI.sessionId(observation.term, observation.key);
            db.query(
              `INSERT INTO session_index (id, term, key, status, ticks, created_at, updated_at)
               VALUES (?, ?, ?, 'running', 0, ?, ?)
               ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
            ).run(id, observation.term, observation.key, observation.at, observation.at);
            switch (observation.type) {
              case "admitted":
                if (observation.parent !== undefined) {
                  db.query(
                    "UPDATE session_index SET parent = ? WHERE id = ?",
                  ).run(
                    AI.sessionId(
                      observation.parent.term,
                      observation.parent.key,
                    ),
                    id,
                  );
                }
                return;
              case "input":
                db.query(
                  `UPDATE session_index SET status = 'running',
                     first_input = COALESCE(first_input, ?) WHERE id = ?`,
                ).run(observation.text.slice(0, 4000), id);
                return;
              case "assistant":
                db.query(
                  "UPDATE session_index SET ticks = ticks + 1 WHERE id = ?",
                ).run(id);
                return;
              case "parked":
                db.query(
                  "UPDATE session_index SET status = 'idle' WHERE id = ?",
                ).run(id);
                return;
              case "settled":
                db.query(
                  "UPDATE session_index SET status = 'settled' WHERE id = ?",
                ).run(id);
                return;
              case "crashed":
                db.query(
                  "UPDATE session_index SET status = 'crashed' WHERE id = ?",
                ).run(id);
                return;
              default:
                return;
            }
          }),
        list: () =>
          Effect.sync(() =>
            (
              db
                .query("SELECT * FROM session_index ORDER BY updated_at DESC")
                .all() as Array<{
                id: string;
                term: string;
                key: string;
                status: AI.SessionSummary["status"];
                ticks: number;
                created_at: number;
                updated_at: number;
                parent: string | null;
                first_input: string | null;
              }>
            ).map(
              (row): AI.SessionSummary => ({
                id: row.id,
                term: row.term,
                key: row.key,
                status: row.status,
                ticks: row.ticks,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                parent: row.parent ?? undefined,
                firstInput: row.first_input ?? undefined,
              }),
            ),
          ),
      });
    }),
  );
