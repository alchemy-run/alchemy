import { Database as SqliteDatabase } from "bun:sqlite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { LEDGER_TABLE, Ledger, META_TABLE } from "./Ledger.ts";


/**
 * The Ledger's bun:sqlite physics — its OWN module so `bun:sqlite`
 * never enters the Worker bundle (LedgerD1.ts mirrors the split).
 *
 * `INSERT OR IGNORE` against the `(queue, key)`
 * primary key is the transaction: the row count says whether THIS
 * offer was the first. Deterministic delivery/identity keys make the
 * dedupe hold across process restarts over the same file.
 */
export const LedgerSqlite = (path: string): Layer.Layer<Ledger> =>
  Layer.effect(
    Ledger,
    Effect.gen(function* () {
      // bun:sqlite is synchronous — every call is wrapped so it
      // participates in the Effect runtime (tracing, error channels).
      // Deliberately NO finalizer: layer construction is isolate-scoped
      // and its finalizers run when the CONSTRUCTING scope closes —
      // which for the local service is right after init, closing the
      // database out from under the long-lived polling fibers. SQLite
      // commits per statement and the ledger is designed to survive
      // process restarts, so the OS closing the fd at exit is enough.
      const db = yield* Effect.try({
        try: () => {
          const database = new SqliteDatabase(path, { create: true });
          database.run(LEDGER_TABLE);
          database.run(META_TABLE);
          return database;
        },
        catch: (cause) =>
          new Error(`LedgerSqlite failed to open ${path}: ${cause}`),
      }).pipe(Effect.orDie);

      return Ledger.of({
        offer: (queue, key, task) =>
          Effect.sync(() => {
            const result = db
              .query(
                "INSERT OR IGNORE INTO ledger (queue, key, task) VALUES (?, ?, ?)",
              )
              .run(queue, key, JSON.stringify(task ?? null));
            return {
              status:
                result.changes > 0
                  ? ("accepted" as const)
                  : ("duplicate" as const),
            };
          }),
        settle: (queue, key) =>
          Effect.sync(() => {
            // unknown key ⇒ zero rows updated ⇒ idempotent no-op
            db.query(
              "UPDATE ledger SET status = 'settled' WHERE queue = ? AND key = ?",
            ).run(queue, key);
          }),
        put: (key, value) =>
          Effect.sync(() => {
            db.query(
              "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
            ).run(key, JSON.stringify(value ?? null));
          }),
        get: (key) =>
          Effect.sync(() => {
            const row = db
              .query("SELECT value FROM meta WHERE key = ?")
              .get(key) as { value: string } | null;
            return row === null ? undefined : JSON.parse(row.value);
          }),
      });
    }),
  );

