import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { createHash, randomBytes } from "node:crypto";
import {
  applyAlchemyFormat,
  detectLayout,
  MigrationError,
  MigrationHistoryConflictError,
  readDrizzleDirRecords,
  readFlatRecords,
  resolveMigrations,
  type MigrationRecord,
  type NormalizedMigrationsInput,
  type SqlExecutor,
  type StampedMigrationsState,
} from "../../SQL/Migrations/index.ts";
import { quoteIdentifier, sqlLiteral } from "../../SQL/Migrations/Records.ts";
import { hashMigrations } from "../../SQL/SqlFile.ts";
import type { FleetResourceAttributes } from "../FleetContext.ts";
import { FleetStorage, type Store } from "../FleetStorage.ts";
import {
  d1Scope,
  FleetOperator,
  type FleetOperatorService,
} from "../OperatorClient.ts";
import { RESOURCE_CATALOG_PREFIX } from "../ResourceCatalog.ts";

const RECEIPTS = "__alchemy_d1_transactions";
const GUARD = "__alchemy_d1_precondition";
const quoted = (name: string) => quoteIdentifier(name, "sqlite");

/** Non-expiring locks fail closed after interruption; elapsed time is not fencing. */
export const migrationLockKey = (databaseId: string) =>
  `${RESOURCE_CATALOG_PREFIX}d1/${encodeURIComponent(databaseId)}.migration-lock.json`;

const migrationError = (cause: unknown) =>
  new MigrationError({
    message:
      "Celld D1 migration operation failed. Inspect the durable ledger and retained migration lock before retrying.",
    cause,
  });

interface MigrationOptions {
  readonly connection: FleetResourceAttributes;
  readonly databaseId: string;
  readonly table: string;
  readonly records: ReadonlyArray<MigrationRecord>;
  readonly store: Store;
  readonly operator: FleetOperatorService;
}

/** Reject changed hashes, duplicate aliases, and histories that are not a local prefix. */
export const validateD1History = (
  table: string,
  records: ReadonlyArray<MigrationRecord>,
  rows: Array<Record<string, unknown>>,
) =>
  Effect.gen(function* () {
    const seen = new Set<number>();
    const conflicts: string[] = [];
    for (const [position, row] of rows.entries()) {
      const name = String(row.name);
      const index = records.findIndex(
        (record) =>
          name === record.name ||
          name === `${record.name}/migration.sql` ||
          name === record.name.replace(/\/migration\.sql$/, ""),
      );
      if (
        index !== position ||
        seen.has(index) ||
        row.hash !== records[index]?.hash
      )
        conflicts.push(name);
      seen.add(index);
    }
    for (let index = 0; index < seen.size; index++) {
      if (!seen.has(index))
        conflicts.push(records[index]?.name ?? "missing local history");
    }
    if (conflicts.length > 0)
      return yield* Effect.fail(
        new MigrationHistoryConflictError({
          table,
          unmatched: conflicts,
          message: `Migration history in '${table}' conflicts with local files; refusing to apply SQL.`,
        }),
      );
  });

/**
 * Adapt the shared registry to Celld's transactional migrate operation, not its
 * nontransactional statements route. All observed registry reads become SQL
 * preconditions inside the same transaction as the migration and ledger insert.
 */
export const applyD1MigrationRecords = (options: MigrationOptions) =>
  Effect.gen(function* () {
    if (options.records.length === 0) return;
    if (options.table === RECEIPTS || options.table === GUARD) {
      return yield* Effect.fail(
        new MigrationError({
          message:
            "The selected migration table is reserved by the Celld migration executor.",
        }),
      );
    }
    const scope = yield* d1Scope(options.databaseId);
    const address = { scope, name: options.databaseId };
    const key = migrationLockKey(options.databaseId);
    const token = yield* Effect.sync(() =>
      Buffer.from(randomBytes(16)).toString("hex"),
    );
    const encode = (value: object) =>
      Effect.sync(() => new TextEncoder().encode(JSON.stringify(value)));
    let lock = yield* options.store
      .put(key, yield* encode({ version: 1, token }), { ifNoneMatch: true })
      .pipe(Effect.mapError(migrationError));
    let uncertain = false;
    let readFailure: MigrationError | undefined;
    let guards: string[] = [];

    const query = (sql: string, params?: ReadonlyArray<unknown>) =>
      options.operator
        .executeD1Statements(options.connection, {
          ...address,
          statements: [{ sql, params: params ? [...params] : undefined }],
        })
        .pipe(
          Effect.flatMap((response) => {
            const result = response.result[0];
            const columns = result?.columns;
            const rows = result?.rows;
            if (
              response.result.length !== 1 ||
              !columns ||
              !rows ||
              rows.some((row) => row.length !== columns.length)
            ) {
              return Effect.fail(
                new MigrationError({
                  message:
                    "Celld returned an incomplete migration query result; refusing to infer missing history.",
                }),
              );
            }
            return Effect.succeed(
              rows.map((row) =>
                Object.fromEntries(
                  row.map((value, index) => [columns[index]!, value]),
                ),
              ),
            );
          }),
          Effect.mapError(migrationError),
        );

    const observe = (
      sql: string,
    ): Effect.Effect<Array<Record<string, unknown>>, MigrationError> =>
      Effect.gen(function* () {
        // Table-valued PRAGMA is composable in the transaction's precondition.
        const pragma = /^PRAGMA table_info\("((?:[^"]|"")*)"\);?$/.exec(sql);
        const selectable = pragma
          ? `SELECT * FROM pragma_table_info(${sqlLiteral(pragma[1]!.replaceAll('""', '"'))})`
          : sql.replace(/;\s*$/, "");
        const rows = yield* query(selectable);
        guards.push(`(SELECT COUNT(*) FROM (${selectable})) = ${rows.length}`);
        for (const row of rows) {
          const fields = Object.entries(row)
            .map(
              ([column, value]) => `${quoted(column)} IS ${sqlLiteral(value)}`,
            )
            .join(" AND ");
          const count = rows.filter((other) =>
            Object.entries(row).every(
              ([column, value]) => other[column] === value,
            ),
          ).length;
          guards.push(
            `(SELECT COUNT(*) FROM (${selectable}) WHERE ${fields}) = ${count}`,
          );
        }
        return rows;
      });

    const executor: SqlExecutor = {
      dialect: "sqlite",
      query: (sql, params) =>
        Effect.gen(function* () {
          if (params?.length)
            return yield* Effect.fail(
              new MigrationError({
                message:
                  "Registry queries must supply literal SQL for transactional precondition capture.",
              }),
            );
          if (sql === `SELECT name FROM ${quoted(options.table)};`) {
            const rows = yield* observe(
              `SELECT name, hash FROM ${quoted(options.table)} ORDER BY id;`,
            );
            yield* validateD1History(options.table, options.records, rows).pipe(
              Effect.mapError(migrationError),
            );
            return rows;
          }
          return yield* observe(sql);
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              readFailure = error;
            }),
          ),
        ),
      batch: (statements) =>
        Effect.gen(function* () {
          // The shared introspector tolerates failed probes; migrations must not.
          if (readFailure) return yield* Effect.fail(readFailure);
          const columns = yield* observe(
            `SELECT * FROM pragma_table_info(${sqlLiteral(options.table)});`,
          );
          if (columns.some((column) => column.name === "hash")) {
            const rows = yield* observe(
              `SELECT name, hash FROM ${quoted(options.table)} ORDER BY id;`,
            );
            yield* validateD1History(options.table, options.records, rows).pipe(
              Effect.mapError(migrationError),
            );
          }
          const migration = options.records.find(
            (record) =>
              record.statements.length + 1 === statements.length &&
              record.statements.every(
                (statement, index) => statement === statements[index],
              ),
          );
          const source = migration
            ? `${migration.sql}\n;\n${statements[statements.length - 1]}\n;`
            : statements.map((statement) => `${statement}\n;`).join("\n");
          const receipt = yield* Effect.sync(
            () =>
              `${token}/${createHash("sha256").update(source).digest("hex")}`,
          );
          const sql = [
            `CREATE TABLE ${quoted(GUARD)} (ok INTEGER NOT NULL);`,
            `INSERT INTO ${quoted(GUARD)} VALUES (CASE WHEN ${guards.length ? guards.join(" AND ") : "1"} THEN 1 ELSE NULL END);`,
            `DROP TABLE ${quoted(GUARD)};`,
            source,
          ].join("\n");
          lock = yield* options.store
            .put(key, yield* encode({ version: 1, token, receipt }), {
              ifMatch: lock.etag,
            })
            .pipe(Effect.mapError(migrationError));
          uncertain = true;
          const outcome = yield* options.operator
            .migrateD1(options.connection, {
              ...address,
              migrate: { name: receipt, table: RECEIPTS, sql },
            })
            .pipe(Effect.result);
          if (Result.isFailure(outcome)) {
            // A missing receipt is not permission to replay: the first request may still be running.
            const tables = yield* query(
              `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${sqlLiteral(RECEIPTS)};`,
            );
            const applied =
              tables.length === 0
                ? []
                : yield* query(
                    `SELECT name FROM ${quoted(RECEIPTS)} WHERE name = ${sqlLiteral(receipt)};`,
                  );
            if (applied.length !== 1)
              return yield* Effect.fail(migrationError(outcome.failure));
          }
          uncertain = false;
          guards = [];
        }),
    };

    const result = yield* applyAlchemyFormat({
      executor,
      table: options.table,
      records: options.records,
    }).pipe(Effect.result);
    if (!uncertain)
      yield* options.store
        .delete(key, { ifMatch: lock.etag })
        .pipe(Effect.mapError(migrationError));
    if (Result.isFailure(result)) return yield* Effect.fail(result.failure);
  });

/** Resolve shared SQL layouts and hashes, then acquire the lock before reading history. */
export const runD1Migrations = (options: {
  readonly connection: FleetResourceAttributes;
  readonly databaseId: string;
  readonly input: NormalizedMigrationsInput;
  readonly stamped: StampedMigrationsState;
}) =>
  Effect.gen(function* () {
    const resolved = resolveMigrations(options);
    const layout = yield* detectLayout(resolved.dir);
    const records =
      layout === "flat"
        ? yield* readFlatRecords(resolved.dir)
        : yield* readDrizzleDirRecords(resolved.dir);
    const hashes = yield* hashMigrations(resolved.dir).pipe(
      Effect.mapError(migrationError),
    );
    if (
      records.some(
        (record) =>
          hashes[
            layout === "flat" ? record.name : `${record.name}/migration.sql`
          ] !== record.hash,
      )
    ) {
      return yield* Effect.fail(
        new MigrationError({
          message:
            "Migration files changed while being read; no SQL was applied.",
        }),
      );
    }
    const storage = yield* FleetStorage;
    const store = yield* storage(options.connection);
    const operator = yield* FleetOperator;
    yield* applyD1MigrationRecords({
      ...options,
      table: resolved.table,
      records,
      store,
      operator,
    });
    return { resolved, hashes };
  });
