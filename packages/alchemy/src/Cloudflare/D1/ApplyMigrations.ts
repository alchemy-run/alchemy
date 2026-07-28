import * as d1 from "@distilled.cloud/cloudflare/d1";
import * as Effect from "effect/Effect";
import type { SqlFile } from "../../SQL/SqlFile.ts";

/**
 * The minimal query surface the migration flow needs: run (possibly
 * multi-statement) SQL and return the D1 HTTP API's result envelope. Two
 * implementations exist:
 *
 * - the cloud executor ({@link applyMigrations}), backed by distilled's
 *   `d1.queryDatabase`;
 * - the local executor (`LocalD1Gateway.ts`), which tunnels the same
 *   protocol into the local workerd D1 simulator.
 */
export interface D1QueryResult {
  result: Array<{
    results?: unknown;
    success?: boolean | null;
    meta?: unknown;
  }>;
}

export type D1SqlExecutor<E = unknown, R = never> = (
  sql: string,
) => Effect.Effect<D1QueryResult, E, R>;

export interface ApplyMigrationsOptions {
  accountId: string;
  databaseId: string;
  migrationsTable: string;
  migrationsFiles: ReadonlyArray<SqlFile>;
}

/**
 * Apply pending D1 migrations in order against the live cloud API. Uses the
 * wrangler-compatible 3-column schema `(id TEXT PK, name TEXT, applied_at
 * TEXT)`.
 */
export const applyMigrations = (options: ApplyMigrationsOptions) =>
  Effect.gen(function* () {
    const queryDb = yield* d1.queryDatabase;
    const executor: D1SqlExecutor<d1.QueryDatabaseError> = (sql) =>
      queryDb({
        accountId: options.accountId,
        databaseId: options.databaseId,
        sql,
      });
    yield* applyMigrationsWith(executor, options);
  });

/**
 * Apply pending D1 migrations in order through the given SQL executor —
 * the executor-agnostic core shared by the cloud and local flows.
 */
export const applyMigrationsWith = <E, R>(
  executor: D1SqlExecutor<E, R>,
  options: {
    migrationsTable: string;
    migrationsFiles: ReadonlyArray<SqlFile>;
  },
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    const { migrationsTable, migrationsFiles } = options;
    yield* ensureMigrationsTable(executor, migrationsTable);
    const applied = yield* getAppliedMigrations(executor, migrationsTable);
    let nextSeq = yield* getNextSeq(executor, migrationsTable);

    for (const migration of migrationsFiles) {
      if (applied.has(migration.id)) continue;
      const migrationId = nextSeq.toString().padStart(5, "0");
      nextSeq += 1;
      // D1 over HTTP doesn't support transactions; run migration + record
      // in a single batched query.
      yield* executor(
        [
          migration.sql,
          `INSERT INTO ${migrationsTable} (id, name, applied_at) VALUES ('${migrationId}', '${migration.id}', datetime('now'));`,
        ].join("\n"),
      );
    }
  });

interface TableColumn {
  name: string;
  type: string;
  pk: number;
}

interface SchemaInfo {
  exists: boolean;
  hasIdColumn: boolean;
  hasNameColumn: boolean;
  isLegacySchema: boolean;
  columns: TableColumn[];
}

const detectSchema = <E, R>(
  executor: D1SqlExecutor<E, R>,
  migrationsTable: string,
) =>
  Effect.gen(function* () {
    const result = yield* executor(
      `PRAGMA table_info(${migrationsTable});`,
    ).pipe(Effect.option);

    const columns: TableColumn[] = [];
    if (result._tag === "Some") {
      const rows = (result.value.result[0]?.results ?? []) as Array<{
        name: string;
        type: string;
        pk: number;
      }>;
      for (const row of rows) {
        columns.push({ name: row.name, type: row.type, pk: row.pk });
      }
    }

    if (columns.length === 0) {
      return {
        exists: false,
        hasIdColumn: false,
        hasNameColumn: false,
        isLegacySchema: false,
        columns,
      } satisfies SchemaInfo;
    }

    const names = columns.map((c) => c.name);
    const hasIdColumn = names.includes("id");
    const hasNameColumn = names.includes("name");
    const isLegacySchema =
      columns.length === 2 && !(hasIdColumn && hasNameColumn);

    return {
      exists: true,
      hasIdColumn,
      hasNameColumn,
      isLegacySchema,
      columns,
    } satisfies SchemaInfo;
  });

const migrateLegacySchema = <E, R>(
  executor: D1SqlExecutor<E, R>,
  migrationsTable: string,
  schema: SchemaInfo,
) =>
  Effect.gen(function* () {
    const primaryColumn =
      schema.columns.find((c) => c.pk === 1)?.name ?? schema.columns[0]?.name;
    if (!primaryColumn) {
      return yield* Effect.die(
        "Cannot migrate legacy migration table: no columns found",
      );
    }
    const tempTable = `${migrationsTable}_temp_migration`;
    yield* executor(
      `CREATE TABLE ${tempTable} (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );`,
    );
    yield* executor(
      `INSERT INTO ${tempTable} (id, name, applied_at)
       SELECT
         printf('%05d', row_number() OVER (ORDER BY applied_at)) as id,
         ${primaryColumn} as name,
         applied_at
       FROM ${migrationsTable}
       ORDER BY applied_at;`,
    );
    yield* executor(`DROP TABLE ${migrationsTable};`);
    yield* executor(`ALTER TABLE ${tempTable} RENAME TO ${migrationsTable};`);
  });

const ensureMigrationsTable = <E, R>(
  executor: D1SqlExecutor<E, R>,
  migrationsTable: string,
) =>
  Effect.gen(function* () {
    const schema = yield* detectSchema(executor, migrationsTable);
    if (!schema.exists) {
      yield* executor(
        `CREATE TABLE ${migrationsTable} (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );`,
      );
      return;
    }
    if (schema.isLegacySchema || !schema.hasIdColumn || !schema.hasNameColumn) {
      yield* migrateLegacySchema(executor, migrationsTable, schema);
    }
  });

const getAppliedMigrations = <E, R>(
  executor: D1SqlExecutor<E, R>,
  migrationsTable: string,
) =>
  Effect.gen(function* () {
    const result = yield* executor(`SELECT name FROM ${migrationsTable};`);
    const rows = (result.result[0]?.results ?? []) as Array<{ name: string }>;
    return new Set(rows.map((r) => r.name));
  });

const getNextSeq = <E, R>(
  executor: D1SqlExecutor<E, R>,
  migrationsTable: string,
) =>
  Effect.gen(function* () {
    const result = yield* executor(
      `SELECT id FROM ${migrationsTable} ORDER BY id;`,
    );
    const rows = (result.result[0]?.results ?? []) as Array<{ id: string }>;
    let max = 0;
    for (const { id } of rows) {
      if (/^\d+$/.test(id)) {
        max = Math.max(max, Number.parseInt(id, 10));
      }
    }
    return max + 1;
  });
