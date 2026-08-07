/**
 * `AI.RunJournal` over bun:sqlite — thread durability: parked runs'
 * threads survive a server restart and restore parked, so the
 * conversation (the MODEL's working context, not just the UI's
 * transcript) continues where it left off.
 *
 * Same sqlite physics as the sibling stores: no finalizer, commits
 * per statement, the OS closes the fd at exit.
 */
import { Database as SqliteDatabase } from "bun:sqlite";
import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const TABLE = `
CREATE TABLE IF NOT EXISTS run_journal (
  term TEXT NOT NULL,
  key  TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (term, key)
)`;

export const SqliteRunJournal = (path: string): Layer.Layer<AI.RunJournal> =>
  Layer.effect(
    AI.RunJournal,
    Effect.gen(function* () {
      const db = yield* Effect.try({
        try: () => {
          const database = new SqliteDatabase(path, { create: true });
          database.run(TABLE);
          return database;
        },
        catch: (cause) =>
          new Error(`SqliteRunJournal failed to open ${path}: ${cause}`),
      }).pipe(Effect.orDie);

      return AI.RunJournal.of({
        save: (snapshot) =>
          Effect.sync(() => {
            db.query(
              "INSERT OR REPLACE INTO run_journal (term, key, data) VALUES (?, ?, ?)",
            ).run(snapshot.term, snapshot.key, JSON.stringify(snapshot));
          }),
        restore: (term) =>
          Effect.sync(() =>
            (
              db
                .query("SELECT data FROM run_journal WHERE term = ?")
                .all(term) as Array<{ data: string }>
            ).map((row) => JSON.parse(row.data) as AI.RunSnapshot),
          ),
        remove: (term, key) =>
          Effect.sync(() => {
            db.query("DELETE FROM run_journal WHERE term = ? AND key = ?").run(
              term,
              key,
            );
          }),
      });
    }),
  );
