/**
 * `AI.SessionIndex` over D1 — the board's rows in the org database
 * (the mirror of SessionIndexSqlite.ts). Ingest runs wherever the
 * driver's `Events` emits — inside session Durable Objects — and
 * the HTTP surface lists from Worker handlers; D1 is the one place
 * they all agree. Summaries ONLY: transcripts live in each session's
 * own DO storage; the live tail rides its socket.
 */
import * as AI from "alchemy/AI";
import * as D1 from "alchemy/Cloudflare/D1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { inWorker, orgDatabase } from "./OrgDatabase.ts";

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

export const SessionIndexD1 = Layer.effect(
  AI.SessionIndex,
  Effect.gen(function* () {
    const db = yield* D1.QueryDatabase(orgDatabase);

    const ensured = yield* Effect.cached(
      inWorker(db.exec(TABLE.trim().replaceAll(/\s+/g, " ")).pipe(Effect.asVoid)),
    );

    return AI.SessionIndex.of({
      ingest: (observation) =>
        Effect.gen(function* () {
          yield* ensured;
          const id = AI.sessionId(observation.term, observation.key);
          yield* inWorker(
            db
              .prepare(
                `INSERT INTO session_index (id, term, key, status, ticks, created_at, updated_at)
                 VALUES (?, ?, ?, 'running', 0, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
              )
              .bind(
                id,
                observation.term,
                observation.key,
                observation.at,
                observation.at,
              )
              .run(),
          );
          switch (observation.type) {
            case "admitted":
              if (observation.parent !== undefined) {
                yield* inWorker(
                  db
                    .prepare("UPDATE session_index SET parent = ? WHERE id = ?")
                    .bind(
                      AI.sessionId(
                        observation.parent.term,
                        observation.parent.key,
                      ),
                      id,
                    )
                    .run(),
                );
              }
              return;
            case "input":
              yield* inWorker(
                db
                  .prepare(
                    `UPDATE session_index SET status = 'running',
                       first_input = COALESCE(first_input, ?) WHERE id = ?`,
                  )
                  .bind(observation.text.slice(0, 4000), id)
                  .run(),
              );
              return;
            case "assistant":
              yield* inWorker(
                db
                  .prepare(
                    "UPDATE session_index SET ticks = ticks + 1 WHERE id = ?",
                  )
                  .bind(id)
                  .run(),
              );
              return;
            case "parked":
              yield* inWorker(
                db
                  .prepare(
                    "UPDATE session_index SET status = 'idle' WHERE id = ?",
                  )
                  .bind(id)
                  .run(),
              );
              return;
            case "settled":
              yield* inWorker(
                db
                  .prepare(
                    "UPDATE session_index SET status = 'settled' WHERE id = ?",
                  )
                  .bind(id)
                  .run(),
              );
              return;
            case "crashed":
              yield* inWorker(
                db
                  .prepare(
                    "UPDATE session_index SET status = 'crashed' WHERE id = ?",
                  )
                  .bind(id)
                  .run(),
              );
              return;
            default:
              return;
          }
        }),
      list: () =>
        Effect.gen(function* () {
          yield* ensured;
          const rows = yield* inWorker(
            db
              .prepare("SELECT * FROM session_index ORDER BY updated_at DESC")
              .all<{
                id: string;
                term: string;
                key: string;
                status: AI.SessionSummary["status"];
                ticks: number;
                created_at: number;
                updated_at: number;
                parent: string | null;
                first_input: string | null;
              }>(),
          );
          return rows.results.map(
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
          );
        }),
    });
  }),
);
