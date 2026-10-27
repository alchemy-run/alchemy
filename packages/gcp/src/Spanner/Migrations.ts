import * as crypto from "node:crypto";
import {
  MigrationError,
  runMigrations,
  type MigrationRecord,
  type NormalizedMigrationsInput,
  type SqlExecutor,
  type StampedMigrationsState,
} from "@alchemy.run/sql/Migrations";
import * as spanner from "@distilled.cloud/gcp/spanner_v1";
import * as Effect from "effect/Effect";
import { waitForOperation } from "../Operation.ts";

/**
 * Spanner names must start with a letter, so the bookkeeping table drops
 * the default `__alchemy_migrations` prefix.
 */
export const SPANNER_MIGRATIONS_TABLE = "alchemy_migrations";

type SpannerDialect = "googlesql" | "postgres";

const DDL = /^(?:CREATE|ALTER|DROP|RENAME|GRANT|REVOKE|ANALYZE)\b/i;

/**
 * Split a migration into single statements with comments removed: Spanner
 * takes one statement per `executeSql` call and per `updateDdl` entry,
 * without terminators. Quoted text (GoogleSQL backslash escapes and triple
 * quotes, PostgreSQL doubled quotes and dollar quotes) never splits.
 */
export const splitSpannerStatements = (sql: string, dialect: SpannerDialect): string[] => {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  const push = () => {
    if (current.trim().length > 0) statements.push(current.trim());
    current = "";
  };
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith("--") || (dialect === "googlesql" && sql[i] === "#")) {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end;
      continue;
    }
    if (rest.startsWith("/*")) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (dialect === "postgres" && sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      current += " ";
      continue;
    }
    const dollar = dialect === "postgres" ? /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(rest) : null;
    if (dollar) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);
      const stop = end < 0 ? sql.length : end + dollar[0].length;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    const ch = sql[i]!;
    if (ch === "'" || ch === '"' || (dialect === "googlesql" && ch === "`")) {
      const triple = dialect === "googlesql" && ch !== "`" && sql.startsWith(ch.repeat(3), i);
      const close = triple ? ch.repeat(3) : ch;
      let j = i + close.length;
      while (j < sql.length) {
        if (dialect === "googlesql" && sql[j] === "\\") {
          j += 2;
          continue;
        }
        if (sql.startsWith(close, j)) {
          j += close.length;
          // PostgreSQL doubles a quote to escape it.
          if (dialect === "postgres" && sql[j] === ch) {
            j++;
            continue;
          }
          break;
        }
        j++;
      }
      current += sql.slice(i, j);
      i = j;
      continue;
    }
    if (ch === ";") {
      push();
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  push();
  return statements;
};

/** Consecutive statements of one kind: DDL goes to `updateDdl`, DML to a transaction. */
const groupStatements = (statements: ReadonlyArray<string>) => {
  const groups: Array<{ ddl: boolean; statements: string[] }> = [];
  for (const statement of statements) {
    const ddl = DDL.test(statement);
    const last = groups.at(-1);
    if (last && last.ddl === ddl) last.statements.push(statement);
    else groups.push({ ddl, statements: [statement] });
  }
  return groups;
};

const toMigrationError =
  (context: string) =>
  <E extends { readonly _tag: string; readonly message?: string }>(cause: E) =>
    new MigrationError({
      message: `${context} failed: ${cause.message ?? cause._tag}`,
      cause,
    });

/**
 * Spanner as a {@link SqlExecutor} over one session. Spanner cannot commit
 * DDL with DML, so DDL runs as `updateDdl` operations and each migration's
 * trailing DML commits in one transaction with its bookkeeping row. A
 * migration's DDL operations are named after the migration, so a deploy
 * that crashed mid-migration waits for the operation it already started
 * instead of running the DDL twice.
 */
const makeSpannerExecutor = Effect.fn(function* (options: {
  database: string;
  dialect: SpannerDialect;
  session: string;
}) {
  const { database, dialect, session } = options;
  const executeSql = yield* spanner.executeSqlProjectsInstancesDatabasesSessions;
  const executeBatchDml = yield* spanner.executeBatchDmlProjectsInstancesDatabasesSessions;
  const commit = yield* spanner.commitProjectsInstancesDatabasesSessions;
  const updateDdl = yield* spanner.updateDdlProjectsInstancesDatabases;
  const getOperation = yield* spanner.getProjectsInstancesDatabasesOperations;

  const awaitDdl = (operation: spanner.Operation) =>
    waitForOperation(operation, (name) => getOperation({ name }), {
      budget: "30 minutes",
      interval: "2 seconds",
    }).pipe(
      Effect.asVoid,
      Effect.mapError((cause) =>
        cause._tag === "GCP.OperationFailed"
          ? new MigrationError({
              message: `Spanner DDL on ${database} failed: ${cause.message}`,
              cause,
            })
          : toMigrationError(`Spanner DDL on ${database}`)(cause),
      ),
    );

  const runDdl = (statements: ReadonlyArray<string>, operationId?: string) =>
    updateDdl({ database, body: { statements: [...statements], operationId } }).pipe(
      Effect.catchTag("DdlOperationIdExists", () =>
        // A previous deploy started this operation; wait for its outcome.
        getOperation({ name: `${database}/operations/${operationId}` }),
      ),
      Effect.mapError(toMigrationError(`Spanner DDL on ${database}`)),
      Effect.flatMap(awaitDdl),
    );

  const runDml = (statements: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const result = yield* executeBatchDml({
        session,
        body: {
          transaction: { begin: { readWrite: {} } },
          seqno: "1",
          statements: statements.map((sql) => ({ sql })),
        },
      }).pipe(Effect.mapError(toMigrationError(`Spanner DML on ${database}`)));
      if (result.status?.code) {
        return yield* new MigrationError({
          message: `Spanner DML on ${database} failed: ${result.status.message ?? `code ${result.status.code}`}`,
        });
      }
      const transactionId = result.resultSets?.[0]?.metadata?.transaction?.id;
      if (!transactionId) {
        return yield* new MigrationError({
          message: `Spanner returned no transaction for DML on ${database}`,
        });
      }
      yield* commit({ session, body: { transactionId } }).pipe(
        Effect.mapError(toMigrationError(`Committing DML on ${database}`)),
      );
    });

  const splitAll = (statements: ReadonlyArray<string>) =>
    statements.flatMap((statement) => splitSpannerStatements(statement, dialect));

  const runGroups = (statements: ReadonlyArray<string>) =>
    Effect.forEach(
      groupStatements(splitAll(statements)),
      (group) => (group.ddl ? runDdl(group.statements) : runDml(group.statements)),
      { discard: true },
    );

  const operationIdOf = (record: MigrationRecord, group: number) =>
    Effect.sync(
      () =>
        `alchemy_${crypto.createHash("sha256").update(`${record.name}\n${record.hash}`).digest("hex").slice(0, 32)}_${group}`,
    );

  return {
    dialect,
    transactionalDdl: false,
    ...(dialect === "postgres"
      ? { migrationTableId: "spanner" as const, defaultSchema: "public" }
      : {}),
    query: (sql) =>
      executeSql({ session, body: { sql: splitAll([sql])[0] ?? sql } }).pipe(
        Effect.mapError(toMigrationError(`Spanner query on ${database}`)),
        Effect.map((result) => {
          const fields = (result.metadata?.rowType?.fields ?? []).map((field) => field.name ?? "");
          return (result.rows ?? []).map((row) =>
            Object.fromEntries(
              fields.map((name, index) => [name, (row as ReadonlyArray<unknown>)[index] ?? null]),
            ),
          );
        }),
      ),
    batch: runGroups,
    applyMigration: (record, bookkeeping) =>
      Effect.gen(function* () {
        const groups = groupStatements(splitAll(record.statements));
        const dml = groups.findIndex((group) => !group.ddl);
        if (dml >= 0 && dml < groups.length - 1) {
          return yield* new MigrationError({
            message: `Spanner migration ${record.name} runs DML between DDL statements. Spanner can't commit DDL and DML together, so put the DML after the migration's DDL or in its own migration.`,
          });
        }
        for (const [index, group] of groups.entries()) {
          if (group.ddl) yield* runDdl(group.statements, yield* operationIdOf(record, index));
        }
        // The trailing DML commits with the bookkeeping row: exactly once.
        const trailing = groups.at(-1);
        yield* runDml([...(trailing && !trailing.ddl ? trailing.statements : []), bookkeeping]);
      }),
  } satisfies SqlExecutor;
});

/**
 * Apply migrations to a Spanner database. Call once the database is ready.
 */
export const runDatabaseMigrations = Effect.fn(function* (options: {
  database: string;
  dialect: SpannerDialect;
  input: NormalizedMigrationsInput;
  stamped: StampedMigrationsState;
}) {
  const createSession = yield* spanner.createProjectsInstancesDatabasesSessions;
  const deleteSession = yield* spanner.deleteProjectsInstancesDatabasesSessions;
  return yield* runMigrations({
    input: { ...options.input, table: options.input.table ?? SPANNER_MIGRATIONS_TABLE },
    stamped: options.stamped,
    withExecutor: (apply) =>
      Effect.acquireUseRelease(
        createSession({ database: options.database, body: {} }).pipe(
          Effect.mapError(toMigrationError(`Opening a session on ${options.database}`)),
        ),
        (session) =>
          makeSpannerExecutor({
            database: options.database,
            dialect: options.dialect,
            session: session.name ?? "",
          }).pipe(Effect.flatMap(apply)),
        (session) => deleteSession({ name: session.name ?? "" }).pipe(Effect.ignore),
      ),
  });
});
