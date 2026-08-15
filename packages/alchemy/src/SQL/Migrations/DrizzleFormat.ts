import * as Effect from "effect/Effect";
import {
  MigrationError,
  type MigrationDialect,
  type SqlExecutor,
} from "./Format.ts";
import { inlineSqlParams } from "./Records.ts";

export const DRIZZLE_DEFAULT_TABLE = "__drizzle_migrations";
export const DRIZZLE_DEFAULT_PG_SCHEMA = "drizzle";

/**
 * Apply a drizzle-v1-layout migrations directory by delegating the entire
 * flow — table DDL, v0→v1 table upgrades, name-keyed applied-detection,
 * hash bookkeeping — to drizzle-orm's own proxy migrators
 * (`sqlite-proxy` / `pg-proxy` / `mysql-proxy`), driven through our
 * {@link SqlExecutor}. Alchemy never writes drizzle's rows itself, so the
 * bookkeeping can't drift from what `drizzle-kit migrate` produces: a user
 * who migrated with drizzle-kit yesterday deploys with Alchemy today (or
 * vice versa) and only pending migrations run.
 *
 * drizzle-orm is an optional peer dependency; it is imported lazily and a
 * missing install fails with an actionable message.
 *
 * Row-shape contract (from drizzle's proxy sessions): sqlite and mysql
 * callbacks return rows as value arrays; pg returns objects for method
 * `execute` and value arrays for `all`. Statement batches (the migration SQL
 * plus drizzle's own bookkeeping INSERTs, pre-inlined by drizzle) go through
 * `executor.batch` as one unit.
 */
export const applyDrizzleFormat = (options: {
  executor: SqlExecutor;
  /** Absolute or cwd-relative path to the drizzle-v1 migrations directory. */
  dir: string;
  table?: string;
  /** Postgres only: the schema holding the migrations table. */
  schema?: string;
}): Effect.Effect<void, MigrationError> =>
  Effect.gen(function* () {
    const { executor, dir } = options;
    const table = options.table ?? DRIZZLE_DEFAULT_TABLE;

    const run = <A>(effect: Effect.Effect<A, MigrationError>): Promise<A> =>
      Effect.runPromise(effect);

    const batchCallback = (queries: string[]) => run(executor.batch(queries));

    yield* Effect.tryPromise({
      try: async () => {
        switch (executor.dialect) {
          case "sqlite": {
            const [{ drizzle }, { migrate }] = await Promise.all([
              importPeer<typeof import("drizzle-orm/sqlite-proxy")>(
                "drizzle-orm/sqlite-proxy",
              ),
              importPeer<typeof import("drizzle-orm/sqlite-proxy/migrator")>(
                "drizzle-orm/sqlite-proxy/migrator",
              ),
            ]);
            const db = drizzle(async (sql, params, method) => {
              const rows = await run(
                executor.query(inlineSqlParams(sql, params ?? [], "sqlite")),
              );
              const values = rows.map((row) => Object.values(row));
              return method === "get"
                ? { rows: values[0] ?? [] }
                : { rows: values };
            });
            await migrate(db, batchCallback, {
              migrationsFolder: dir,
              migrationsTable: table,
            });
            return;
          }
          case "postgres": {
            const [{ drizzle }, { migrate }] = await Promise.all([
              importPeer<typeof import("drizzle-orm/pg-proxy")>(
                "drizzle-orm/pg-proxy",
              ),
              importPeer<typeof import("drizzle-orm/pg-proxy/migrator")>(
                "drizzle-orm/pg-proxy/migrator",
              ),
            ]);
            const db = drizzle(async (sql, params, method) => {
              const rows = await run(executor.query(sql, params ?? []));
              return method === "all"
                ? { rows: rows.map((row) => Object.values(row)) }
                : { rows };
            });
            await migrate(db, batchCallback, {
              migrationsFolder: dir,
              migrationsTable: table,
              migrationsSchema: options.schema ?? DRIZZLE_DEFAULT_PG_SCHEMA,
            });
            return;
          }
          case "mysql": {
            const [{ drizzle }, { migrate }] = await Promise.all([
              importPeer<typeof import("drizzle-orm/mysql-proxy")>(
                "drizzle-orm/mysql-proxy",
              ),
              importPeer<typeof import("drizzle-orm/mysql-proxy/migrator")>(
                "drizzle-orm/mysql-proxy/migrator",
              ),
            ]);
            const db = drizzle(async (sql, params, method) => {
              const rows = await run(executor.query(sql, params ?? []));
              return method === "all"
                ? { rows: rows.map((row) => Object.values(row)) }
                : { rows };
            });
            await migrate(db, batchCallback, {
              migrationsFolder: dir,
              migrationsTable: table,
            });
            return;
          }
        }
      },
      catch: (cause) =>
        cause instanceof MigrationError
          ? cause
          : new MigrationError({
              message: `drizzle migration failed: ${cause instanceof Error ? cause.message : String(cause)}`,
              cause,
            }),
    });
  });

const importPeer = <T>(specifier: string): Promise<T> =>
  import(/* @vite-ignore */ specifier).catch((cause) => {
    throw new MigrationError({
      message:
        `Failed to load "${specifier}". Applying drizzle-format migrations requires ` +
        `the optional peer dependency "drizzle-orm" — install it in your project.`,
      cause,
    });
  }) as Promise<T>;

/** The default migrations table/schema for a drizzle target. */
export const drizzleDefaultTable = (_dialect: MigrationDialect) =>
  DRIZZLE_DEFAULT_TABLE;
