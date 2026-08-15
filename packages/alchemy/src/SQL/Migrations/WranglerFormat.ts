import * as Effect from "effect/Effect";
import {
  MigrationError,
  MigrationHistoryConflictError,
  type MigrationRecord,
  type SqlExecutor,
} from "./Format.ts";
import { classifyTable, tableColumns } from "./Introspect.ts";
import { quoteIdentifier, sqlLiteral } from "./Records.ts";

export const WRANGLER_DEFAULT_TABLE = "d1_migrations";

/** Wrangler's real DDL, verbatim (src/d1/migrations/helpers.ts). */
const createTableSql = (table: string) =>
  `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table, "sqlite")}(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`;

/**
 * Ensure the bookkeeping table exists in wrangler's shape, upgrading a
 * legacy Alchemy table (TEXT id / 2-column) in place via rebuild. The
 * rebuild carries `name` (or the old primary column, which held the name in
 * the 2-column era) and `applied_at` across, ordered by the old id so
 * autoincrement ids preserve application order.
 */
const ensureTable = (executor: SqlExecutor, table: string) =>
  Effect.gen(function* () {
    const shape = classifyTable(yield* tableColumns(executor, table));
    switch (shape) {
      case "absent":
        yield* executor.batch([createTableSql(table)]);
        return;
      case "wrangler":
        return;
      case "legacy-alchemy":
      case "legacy-2col": {
        const quoted = quoteIdentifier(table, "sqlite");
        const temp = quoteIdentifier(`${table}_alchemy_upgrade`, "sqlite");
        const nameExpr = shape === "legacy-alchemy" ? "name" : "id";
        yield* executor.batch([
          `DROP TABLE IF EXISTS ${temp};`,
          `CREATE TABLE ${temp}(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`,
          `INSERT INTO ${temp} (name, applied_at)
             SELECT ${nameExpr}, applied_at FROM ${quoted} ORDER BY id;`,
          `DROP TABLE ${quoted};`,
          `ALTER TABLE ${temp} RENAME TO ${quoted};`,
        ]);
        return;
      }
      case "drizzle-shaped":
        return yield* new MigrationError({
          message:
            `Migrations table "${table}" has drizzle's column shape (a "hash" column) ` +
            `but the resolved format is "wrangler". Point the resource at the drizzle ` +
            `format explicitly, or use a different migrations table.`,
        });
      case "unknown":
        return yield* new MigrationError({
          message:
            `Migrations table "${table}" has an unrecognized column layout; ` +
            `refusing to write wrangler-format bookkeeping into it.`,
        });
    }
  });

const appliedNames = (executor: SqlExecutor, table: string) =>
  executor
    .query(`SELECT name FROM ${quoteIdentifier(table, "sqlite")};`)
    .pipe(Effect.map((rows) => new Set(rows.map((row) => String(row.name)))));

/**
 * Apply pending migrations with wrangler-format bookkeeping
 * (`d1_migrations`, name-keyed, applied_at defaulted server-side). Each
 * migration and its bookkeeping INSERT go through `executor.batch` as one
 * unit — a single batched query on D1, which has no transactions over HTTP.
 */
export const applyWranglerFormat = (options: {
  executor: SqlExecutor;
  table: string;
  records: ReadonlyArray<MigrationRecord>;
}): Effect.Effect<void, MigrationError | MigrationHistoryConflictError> =>
  Effect.gen(function* () {
    const { executor, table, records } = options;
    if (records.length === 0) return;
    yield* ensureTable(executor, table);
    const applied = yield* appliedNames(executor, table);
    for (const record of records) {
      if (applied.has(record.name)) continue;
      yield* executor.batch([
        ...record.statements,
        `INSERT INTO ${quoteIdentifier(table, "sqlite")} (name) VALUES (${sqlLiteral(record.name)});`,
      ]);
    }
  });
