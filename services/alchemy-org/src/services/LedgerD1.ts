/**
 * The Ledger's D1 physics — its own module (the mirror of
 * LedgerSqlite.ts): the local process never bundles Cloudflare's D1
 * client, and the Worker never bundles `bun:sqlite`.
 */
import * as D1 from "alchemy/Cloudflare/D1";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { LEDGER_TABLE, Ledger, META_TABLE } from "./Ledger.ts";

/**
 * D1 physics — the implementation OWNS its infrastructure: the
 * `org-ledger` D1 database resource is declared inside this Layer (the
 * bindings pattern applied above the resource level); no process Layer
 * ever sees the table.
 *
 * `INSERT OR IGNORE` decides acceptance in the database — never any
 * instance's memory — so a stateless, concurrent Worker fleet and a
 * laptop process run identical drive code.
 *
 * TODO(deploy): the table is ensured lazily on first offer (D1 `exec`
 * from the delivery path). Once this Worker actually deploys, move the
 * DDL to a `Cloudflare.D1.ApplyMigrations` resource next to the
 * Database declaration and delete the lazy ensure.
 */
// (the Layer's requirement channel is inferred: the QueryDatabase
// binding tag plus the Database resource's provisioning context —
// ambient in a Worker's init Effect, the only place this Layer builds)
export const D1Ledger = Layer.effect(
  Ledger,
  Effect.gen(function* () {
    const database = yield* D1.Database("org-ledger");
    const db = yield* D1.QueryDatabase(database);

    // The D1 client's executors are colored with RuntimeContext ("runs
    // only inside the deployed Worker"). The Ledger contract is
    // environment-agnostic, and this Layer is the one place that KNOWS
    // its calls run inside the Worker's delivery handlers — so the
    // color is discharged here (the color is phantom: nothing reads
    // the service; see PreparedStatement.withRuntime).
    const inWorker = <A, E>(
      effect: Effect.Effect<A, E, RuntimeContext>,
    ): Effect.Effect<A, E> => Effect.provide(effect, RuntimeContext.phantom);

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
          const rows = yield* inWorker(
            db
              .prepare("SELECT value FROM meta WHERE key = ?")
              .bind(key)
              .all<{ value: string }>(),
          );
          const row = rows.results[0];
          return row === undefined ? undefined : JSON.parse(row.value);
        }),
    });
  }),
);
