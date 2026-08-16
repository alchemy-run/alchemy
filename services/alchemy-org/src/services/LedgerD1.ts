import * as D1 from "alchemy/Cloudflare/D1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { LEDGER_TABLE, Ledger, META_TABLE } from "./Ledger.ts";
import { inWorker, orgDatabase } from "./OrgDatabase.ts";

/**
 * The Ledger's D1 physics — its own module (the mirror of
 * LedgerSqlite.ts): the local process never bundles Cloudflare's D1
 * client, and the Worker never bundles `bun:sqlite`.
 *
 * `INSERT OR IGNORE` decides acceptance in the database — never any
 * instance's memory — so a stateless, concurrent Worker fleet and a
 * laptop process run identical drive code.
 */
export const LedgerD1 = Layer.effect(
  Ledger,
  Effect.gen(function* () {
    const db = yield* D1.QueryDatabase(orgDatabase);

    // ensured lazily on first use — DDL from the delivery path; D1
    // `exec` wants single-line statements
    const ensured = yield* Effect.cached(
      inWorker(
        db
          .exec(LEDGER_TABLE.trim().replaceAll(/\s+/g, " "))
          .pipe(
            Effect.andThen(db.exec(META_TABLE.trim().replaceAll(/\s+/g, " "))),
            Effect.asVoid,
          ),
      ),
    );

    return Ledger.of({
      offer: (queue, key, task) =>
        Effect.gen(function* () {
          yield* ensured;
          const result = yield* inWorker(
            db
              .prepare(
                "INSERT OR IGNORE INTO ledger (queue, key, task) VALUES (?, ?, ?)",
              )
              .bind(queue, key, JSON.stringify(task ?? null))
              .run(),
          );
          return {
            status:
              result.meta.changes > 0
                ? ("accepted" as const)
                : ("duplicate" as const),
          };
        }),
      settle: (queue, key) =>
        Effect.gen(function* () {
          yield* ensured;
          yield* inWorker(
            db
              .prepare(
                "UPDATE ledger SET status = 'settled' WHERE queue = ? AND key = ?",
              )
              .bind(queue, key)
              .run(),
          );
        }),
      put: (key, value) =>
        Effect.gen(function* () {
          yield* ensured;
          yield* inWorker(
            db
              .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
              .bind(key, JSON.stringify(value ?? null))
              .run(),
          );
        }),
      get: (key) =>
        Effect.gen(function* () {
          yield* ensured;
          const row = yield* inWorker(
            db
              .prepare("SELECT value FROM meta WHERE key = ?")
              .bind(key)
              .first<{ value: string }>(),
          );
          return row === null ? undefined : JSON.parse(row.value);
        }),
    });
  }),
);
