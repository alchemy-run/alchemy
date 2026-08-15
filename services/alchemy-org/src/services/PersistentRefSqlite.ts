/**
 * `PersistentRef.Store` over bun:sqlite — the LOCAL durability half of
 * the bootstrap's restart surface (designs/ai/bootstrap.md §3): refs
 * written through this store survive the reload cycle (process exit +
 * resurrection), so run state persists while behavior code changes.
 *
 * Same physics decisions as {@link LedgerSqlite}: no finalizer (layer
 * construction is isolate-scoped; sqlite commits per statement; the
 * OS closing the fd at exit is enough), one file, keys flattened with
 * the canonical {@link PersistentRef.pathKey} encoding.
 */
import { Database as SqliteDatabase } from "bun:sqlite";
import * as PersistentRef from "alchemy/PersistentRef";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const TABLE = `
CREATE TABLE IF NOT EXISTS refs (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;

/**
 * Values are wrapped (`{ v: encoded }`) so `undefined` round-trips:
 * `JSON.stringify({ v: undefined })` is `"{}"`, which parses back to
 * `undefined` — while a legitimate `null` stays `null`.
 */
export const PersistentRefSqlite = (
  path: string,
): Layer.Layer<PersistentRef.Store> =>
  Layer.effect(
    PersistentRef.Store,
    Effect.gen(function* () {
      const db = yield* Effect.try({
        try: () => {
          const database = new SqliteDatabase(path, { create: true });
          database.run(TABLE);
          return database;
        },
        catch: (cause) =>
          new Error(`PersistentRefSqlite failed to open ${path}: ${cause}`),
      }).pipe(Effect.orDie);

      return PersistentRef.Store.of({
        load: (key) =>
          Effect.sync(() => {
            const row = db
              .query("SELECT value FROM refs WHERE key = ?")
              .get(PersistentRef.pathKey(key)) as { value: string } | null;
            if (row === null) return undefined;
            return (JSON.parse(row.value) as { v?: unknown }).v;
          }),
        write: (key, encoded) =>
          Effect.sync(() => {
            db.query(
              "INSERT OR REPLACE INTO refs (key, value) VALUES (?, ?)",
            ).run(PersistentRef.pathKey(key), JSON.stringify({ v: encoded }));
          }),
      });
    }),
  );
