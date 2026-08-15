import * as Effect from "effect/Effect";
import {
  MigrationError,
  MigrationHistoryConflictError,
  type MigrationDialect,
  type MigrationRecord,
  type SqlExecutor,
} from "./Format.ts";
import { classifyTable, tableColumns } from "./Introspect.ts";
import { quoteIdentifier, sqlLiteral } from "./Records.ts";

export const ALCHEMY_DEFAULT_TABLE = "__alchemy_migrations";

/**
 * The `alchemy` format is deliberately NOT a fifth invented shape — it is
 * drizzle's column shape (`id, hash, created_at, name, applied_at`,
 * name-keyed applied-detection) under a neutral table name, so a later
 * "I adopted drizzle-kit" conversion is a rename plus a name rewrite rather
 * than a data migration.
 */
const createTableSql = (table: string, dialect: MigrationDialect): string => {
  const quoted = quoteIdentifier(table, dialect);
  switch (dialect) {
    case "sqlite":
      return `CREATE TABLE IF NOT EXISTS ${quoted} (
  id INTEGER PRIMARY KEY,
  hash text NOT NULL,
  created_at numeric,
  name text,
  applied_at TEXT
);`;
    case "postgres":
      return `CREATE TABLE IF NOT EXISTS ${quoted} (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint,
  name text,
  applied_at timestamp with time zone DEFAULT now()
);`;
    case "mysql":
      return `CREATE TABLE IF NOT EXISTS ${quoted} (
  id SERIAL PRIMARY KEY,
  hash TEXT NOT NULL,
  created_at BIGINT,
  name TEXT,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`;
  }
};

const insertSql = (
  table: string,
  dialect: MigrationDialect,
  record: Pick<MigrationRecord, "name" | "hash" | "createdAtMillis">,
  appliedAt?: string,
): string => {
  const quoted = quoteIdentifier(table, dialect);
  const applied =
    dialect === "sqlite"
      ? `, ${appliedAt ? sqlLiteral(appliedAt) : "datetime('now')"}`
      : appliedAt
        ? `, ${sqlLiteral(appliedAt)}`
        : "";
  const appliedColumn = dialect === "sqlite" || appliedAt ? ", applied_at" : "";
  return `INSERT INTO ${quoted} (hash, created_at, name${appliedColumn}) VALUES (${sqlLiteral(record.hash)}, ${sqlLiteral(record.createdAtMillis ?? null)}, ${sqlLiteral(record.name)}${applied});`;
};

const renameSql = (
  from: string,
  to: string,
  dialect: MigrationDialect,
): string =>
  dialect === "mysql"
    ? `RENAME TABLE ${quoteIdentifier(from, dialect)} TO ${quoteIdentifier(to, dialect)};`
    : `ALTER TABLE ${quoteIdentifier(from, dialect)} RENAME TO ${quoteIdentifier(to, dialect)};`;

/**
 * Rebuild a legacy Alchemy table (`id TEXT PK, name, applied_at` — or the
 * 2-column shape whose primary column carried the name) into the current
 * drizzle-shaped table, backfilling `hash`/`created_at` from local records
 * matched by name. A recorded row with no matching local file is a
 * hard error, mirroring drizzle's own `upgradeIfNeeded`: it means
 * migrations were applied that this checkout does not have.
 */
const upgradeLegacyTable = (options: {
  executor: SqlExecutor;
  table: string;
  records: ReadonlyArray<MigrationRecord>;
  twoColumn: boolean;
}) =>
  Effect.gen(function* () {
    const { executor, table, records, twoColumn } = options;
    const dialect = executor.dialect;
    const quoted = quoteIdentifier(table, dialect);
    const nameExpr = twoColumn ? "id" : "name";
    const rows = yield* executor.query(
      `SELECT ${nameExpr} AS name, applied_at FROM ${quoted} ORDER BY id;`,
    );

    const byName = new Map(records.map((r) => [r.name, r]));
    // Legacy state written against drizzle-layout dirs recorded
    // `dir/migration.sql`; current records key drizzle dirs by `dir`.
    const byDirName = new Map(
      records.map((r) => [`${r.name}/migration.sql`, r]),
    );
    const matched: Array<{
      record: MigrationRecord;
      name: string;
      appliedAt: string | undefined;
    }> = [];
    const unmatched: string[] = [];
    for (const row of rows) {
      const name = String(row.name);
      const record = byName.get(name) ?? byDirName.get(name);
      if (!record) {
        unmatched.push(name);
        continue;
      }
      matched.push({
        record,
        // Preserve the recorded key so applied-detection keeps matching
        // state written by older Alchemy versions.
        name,
        appliedAt:
          row.applied_at === null || row.applied_at === undefined
            ? undefined
            : String(row.applied_at),
      });
    }
    if (unmatched.length > 0) {
      return yield* new MigrationHistoryConflictError({
        table,
        unmatched,
        message:
          `While upgrading migrations table "${table}", ${unmatched.length} recorded ` +
          `migration(s) match no local file: ${unmatched.join(", ")}. Migrations were ` +
          `applied to this database that are missing from the local environment.`,
      });
    }

    const temp = `${table}_alchemy_upgrade`;
    yield* executor.batch([
      `DROP TABLE IF EXISTS ${quoteIdentifier(temp, dialect)};`,
      createTableSql(temp, dialect).replace(
        "CREATE TABLE IF NOT EXISTS",
        "CREATE TABLE",
      ),
      ...matched.map(({ record, name, appliedAt }) =>
        insertSql(
          temp,
          dialect,
          { name, hash: record.hash, createdAtMillis: record.createdAtMillis },
          appliedAt,
        ),
      ),
      `DROP TABLE ${quoted};`,
      renameSql(temp, table, dialect),
    ]);
  });

const ensureTable = (options: {
  executor: SqlExecutor;
  table: string;
  records: ReadonlyArray<MigrationRecord>;
}) =>
  Effect.gen(function* () {
    const { executor, table, records } = options;
    const shape = classifyTable(yield* tableColumns(executor, table));
    switch (shape) {
      case "absent":
        yield* executor.batch([createTableSql(table, executor.dialect)]);
        return;
      case "drizzle-shaped":
        return;
      case "legacy-alchemy":
        yield* upgradeLegacyTable({
          executor,
          table,
          records,
          twoColumn: false,
        });
        return;
      case "legacy-2col":
        yield* upgradeLegacyTable({
          executor,
          table,
          records,
          twoColumn: true,
        });
        return;
      case "wrangler":
      case "unknown":
        return yield* new MigrationError({
          message:
            `Migrations table "${table}" has an unexpected column layout for the ` +
            `"alchemy" format; refusing to write bookkeeping into it.`,
        });
    }
  });

const appliedNames = (executor: SqlExecutor, table: string) =>
  executor
    .query(`SELECT name FROM ${quoteIdentifier(table, executor.dialect)};`)
    .pipe(
      Effect.map(
        (rows) =>
          new Set(
            rows
              .map((row) => row.name)
              .filter((name) => name !== null && name !== undefined)
              .map(String),
          ),
      ),
    );

/**
 * Apply pending migrations with `alchemy`-format bookkeeping: drizzle's
 * column shape under `__alchemy_migrations`, name-keyed detection. Each
 * migration's statements and its bookkeeping INSERT go through
 * `executor.batch` as one unit (a transaction on pg/mysql, one batched
 * query on D1).
 *
 * Legacy names: pre-registry Alchemy recorded drizzle-layout migrations as
 * `dir/migration.sql`. After a legacy upgrade those rows keep their key, so
 * applied-detection here checks both the record name and its
 * `/migration.sql`-suffixed alias.
 */
export const applyAlchemyFormat = (options: {
  executor: SqlExecutor;
  table: string;
  records: ReadonlyArray<MigrationRecord>;
}): Effect.Effect<void, MigrationError | MigrationHistoryConflictError> =>
  Effect.gen(function* () {
    const { executor, table, records } = options;
    if (records.length === 0) return;
    yield* ensureTable(options);
    const applied = yield* appliedNames(executor, table);
    for (const record of records) {
      if (
        applied.has(record.name) ||
        applied.has(`${record.name}/migration.sql`)
      ) {
        continue;
      }
      yield* executor.batch([
        ...record.statements,
        insertSql(table, executor.dialect, record),
      ]);
    }
  });
