import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

/** SQL calls use the public Effect wrapper; only the sync transaction is native. */
export class SqlObject extends Cloudflare.DurableObject<SqlObject>()(
  "DeepSqlObject",
  Effect.succeed(
    Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      const sql = state.storage.sql;
      const actorId = state.id.toString();
      yield* sql.exec(
        "CREATE TABLE IF NOT EXISTS benchmark (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)",
      );

      return {
        noop: () => Effect.succeed({ actorId, count: 0, rows: 0, checksum: 0 }),
        writeRead: (count: number) =>
          Effect.gen(function* () {
            if (count !== 100 && count !== 1000)
              return yield* Effect.die(new Error("SQL count must be 100 or 1000"));
            const context = yield* Effect.context<RuntimeContext>();
            const program = Effect.gen(function* () {
              yield* sql.exec("DELETE FROM benchmark");
              for (let index = 0; index < count; index++) {
                yield* sql.exec(
                  "INSERT INTO benchmark (id, value) VALUES (?, ?)",
                  index,
                  index + 1,
                );
              }
              const summary = yield* sql
                .exec<{ rows: number; checksum: number }>(
                  "SELECT COUNT(*) AS rows, COALESCE(SUM(value), 0) AS checksum FROM benchmark",
                )
                .pipe(Effect.flatMap((cursor) => cursor.one()));
              const rows = yield* sql
                .exec<{ id: number; value: number }>("SELECT id, value FROM benchmark ORDER BY id")
                .pipe(Effect.flatMap((cursor) => cursor.toArray()));
              const checksum = rows.reduce((sum, row) => sum + row.value, 0);
              if (
                rows.length !== count ||
                summary.rows !== count ||
                summary.checksum !== (count * (count + 1)) / 2 ||
                checksum !== summary.checksum ||
                rows.some((row, index) => row.id !== index || row.value !== index + 1)
              ) {
                return yield* Effect.die(new Error("SQL scalar/row checksum mismatch"));
              }
              return { actorId, count, rows: rows.length, checksum };
            });
            // All effects above are synchronous sql.exec/one/toArray operations.
            // Do not introduce async I/O, nested async transactions, or yields here.
            return yield* Effect.sync(() =>
              state.raw.storage.transactionSync(() => Effect.runSyncWith(context)(program)),
            );
          }),
      };
    }),
  ),
) {}
