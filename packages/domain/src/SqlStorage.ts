import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { SqlError } from "effect/sql/SqlError";
import { type Reader, Storage, StorageError, type Transaction } from "./Storage.ts";

/**
 * Options for {@link layer}.
 */
export interface Options {
  /**
   * Prefix of the three tables the domain is kept in: `{prefix}_kv` (values),
   * `{prefix}_partition` (one row per partition, locked by each transaction)
   * and `{prefix}_timer` (durable timers). Created on first use.
   * @default "domain"
   */
  readonly tablePrefix?: string;
}

type Dialect = "pg" | "mysql" | "sqlite";

/** Rows per multi-row insert, well under every dialect's bound-parameter limit. */
const CHUNK = 200;

const schemaFor = (dialect: Dialect, prefix: string): ReadonlyArray<string> => {
  const [kv, partition, timer] = [`${prefix}_kv`, `${prefix}_partition`, `${prefix}_timer`];
  switch (dialect) {
    // `COLLATE "C"` orders keys by code point, so prefix ranges are exact.
    case "pg":
      return [
        `CREATE TABLE IF NOT EXISTS "${kv}" (part TEXT COLLATE "C" NOT NULL, k TEXT COLLATE "C" NOT NULL, v TEXT NOT NULL, PRIMARY KEY (part, k))`,
        `CREATE TABLE IF NOT EXISTS "${partition}" (part TEXT COLLATE "C" PRIMARY KEY, ver BIGINT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS "${timer}" (part TEXT COLLATE "C" NOT NULL, name TEXT COLLATE "C" NOT NULL, due BIGINT NOT NULL, PRIMARY KEY (part, name))`,
        `CREATE INDEX IF NOT EXISTS "${timer}_due" ON "${timer}" (due)`,
      ];
    case "mysql": {
      const text = "VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL";
      return [
        `CREATE TABLE IF NOT EXISTS \`${kv}\` (part ${text}, k ${text}, v LONGTEXT NOT NULL, PRIMARY KEY (part, k))`,
        `CREATE TABLE IF NOT EXISTS \`${partition}\` (part ${text} PRIMARY KEY, ver BIGINT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS \`${timer}\` (part ${text}, name ${text}, due BIGINT NOT NULL, PRIMARY KEY (part, name), INDEX \`${timer}_due\` (due))`,
      ];
    }
    case "sqlite":
      return [
        `CREATE TABLE IF NOT EXISTS "${kv}" (part TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (part, k)) WITHOUT ROWID`,
        `CREATE TABLE IF NOT EXISTS "${partition}" (part TEXT PRIMARY KEY, ver INTEGER NOT NULL) WITHOUT ROWID`,
        `CREATE TABLE IF NOT EXISTS "${timer}" (part TEXT NOT NULL, name TEXT NOT NULL, due INTEGER NOT NULL, PRIMARY KEY (part, name)) WITHOUT ROWID`,
        `CREATE INDEX IF NOT EXISTS "${timer}_due" ON "${timer}" (due)`,
      ];
  }
};

/** The smallest string after every string that starts with `prefix`. */
const successor = (prefix: string): string | undefined =>
  prefix.length === 0
    ? undefined
    : prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);

const chunks = <A>(items: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> => {
  const out: Array<ReadonlyArray<A>> = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
};

const storageError = (error: SqlError) =>
  new StorageError({ message: `Domain storage: ${error.message}`, cause: error });

/** A deadlock, serialization failure, lock timeout or dropped connection: the transaction can run again. */
const isRetryable = (error: unknown) =>
  error instanceof StorageError && error.cause instanceof SqlError && error.cause.isRetryable;

/**
 * Build a {@link Storage} over the ambient `SqlClient`.
 */
export const make = (options: Options = {}) =>
  Effect.gen(function* () {
    const prefix = options.tablePrefix ?? "domain";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) {
      return yield* Effect.die(new Error(`SqlStorage: invalid table prefix ${prefix}`));
    }
    // Our column names are plain lowercase words, but the client may rename
    // columns (camelCase transforms); read and write them as they are.
    const sql = (yield* SqlClient.SqlClient).withoutTransforms();
    const dialect = sql.onDialectOrElse<Dialect | undefined, Dialect, Dialect, Dialect>({
      orElse: () => undefined,
      pg: () => "pg",
      mysql: () => "mysql",
      sqlite: () => "sqlite",
    });
    if (dialect === undefined) {
      return yield* Effect.die(new Error("SqlStorage supports Postgres, MySQL and SQLite clients"));
    }
    const kv = sql(`${prefix}_kv`);
    const partitions = sql(`${prefix}_partition`);
    const timers = sql(`${prefix}_timer`);

    // Every operation is its own unit of work, never part of a transaction the
    // caller happens to be in: strip it, so our statements take their own
    // connection and our commits don't wait on (or roll back with) theirs.
    const isolated = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.updateContext(
        effect,
        (context: Context.Context<R>) =>
          Context.omit(sql.transactionService)(context) as Context.Context<R>,
      );

    // Create the tables on first use (not at Layer build, so building the
    // Layer never does I/O). Concurrent first boots may race on DDL: retry.
    let ready = false;
    const once = Semaphore.makeUnsafe(1);
    const ensure = Effect.suspend(() =>
      ready
        ? Effect.void
        : once.withPermits(1)(
            Effect.suspend(() =>
              ready
                ? Effect.void
                : Effect.forEach(schemaFor(dialect, prefix), (statement) => sql.unsafe(statement), {
                    discard: true,
                  }).pipe(
                    Effect.retry({ times: 3, schedule: Schedule.exponential("100 millis") }),
                    Effect.tap(() => Effect.sync(() => void (ready = true))),
                  ),
            ),
          ),
    ).pipe(Effect.mapError(storageError));

    const run = <A>(statement: Effect.Effect<A, SqlError>) =>
      statement.pipe(Effect.mapError(storageError));

    const reader = (partition: string): Reader => ({
      get: <A>(key: string) =>
        run(sql<{ v: string }>`SELECT v FROM ${kv} WHERE part = ${partition} AND k = ${key}`).pipe(
          Effect.map((rows) => (rows[0] ? (JSON.parse(rows[0].v) as A) : undefined)),
        ),
      list: <A>({
        prefix: keyPrefix,
        start,
        limit,
      }: {
        prefix: string;
        start?: string;
        limit?: number;
      }) => {
        const lower = start !== undefined && start > keyPrefix ? start : keyPrefix;
        const upper = successor(keyPrefix);
        const range = upper === undefined ? sql`` : sql`AND k < ${upper}`;
        const bound =
          limit === undefined ? sql`` : sql.literal(`LIMIT ${Math.max(0, Math.floor(limit))}`);
        return run(
          sql<{
            k: string;
            v: string;
          }>`SELECT k, v FROM ${kv} WHERE part = ${partition} AND k >= ${lower} ${range} ORDER BY k ${bound}`,
        ).pipe(Effect.map((rows) => rows.map((row) => [row.k, JSON.parse(row.v) as A] as const)));
      },
      timer: (name) =>
        run(
          sql<{
            due: number | string | bigint;
          }>`SELECT due FROM ${timers} WHERE part = ${partition} AND name = ${name}`,
        ).pipe(Effect.map((rows) => (rows[0] ? Number(rows[0].due) : undefined))),
    });

    const upsert =
      dialect === "mysql"
        ? (column: string) => sql.literal(`ON DUPLICATE KEY UPDATE ${column} = VALUES(${column})`)
        : (column: string, ...key: Array<string>) =>
            sql.literal(
              `ON CONFLICT (${key.join(", ")}) DO UPDATE SET ${column} = excluded.${column}`,
            );

    const transaction = (partition: string): Transaction => ({
      ...reader(partition),
      put: (entries) =>
        Effect.forEach(
          chunks(
            Object.entries(entries).map(([k, v]) => ({ part: partition, k, v: JSON.stringify(v) })),
          ),
          (rows) => run(sql`INSERT INTO ${kv} ${sql.insert(rows)} ${upsert("v", "part", "k")}`),
          { discard: true },
        ),
      delete: (keys) =>
        Effect.forEach(
          chunks(keys),
          (some) => run(sql`DELETE FROM ${kv} WHERE part = ${partition} AND ${sql.in("k", some)}`),
          { discard: true },
        ),
      setTimer: (name, at) =>
        run(
          sql`INSERT INTO ${timers} ${sql.insert({ part: partition, name, due: Math.floor(at) })} ${upsert("due", "part", "name")}`,
        ).pipe(Effect.asVoid),
      deleteTimer: (name) =>
        run(sql`DELETE FROM ${timers} WHERE part = ${partition} AND name = ${name}`).pipe(
          Effect.asVoid,
        ),
    });

    // Writing the partition's row first takes its row lock (Postgres, MySQL)
    // or the database's write lock (SQLite) until the transaction ends.
    const lock = (partition: string) =>
      dialect === "mysql"
        ? sql`INSERT INTO ${partitions} (part, ver) VALUES (${partition}, 1) ON DUPLICATE KEY UPDATE ver = ver + 1`
        : sql`INSERT INTO ${partitions} (part, ver) VALUES (${partition}, 1) ON CONFLICT (part) DO UPDATE SET ver = ${partitions}.ver + 1`;

    return Storage.of({
      transact: (partition, f) =>
        isolated(
          ensure.pipe(
            Effect.andThen(
              sql
                .withTransaction(
                  run(lock(partition)).pipe(Effect.andThen(f(transaction(partition)))),
                )
                .pipe(
                  Effect.catchIf(
                    (error): error is SqlError => error instanceof SqlError,
                    (error) => Effect.fail(storageError(error)),
                  ),
                ),
            ),
            Effect.retry({
              while: isRetryable,
              times: 5,
              schedule: Schedule.exponential("50 millis"),
            }),
          ),
        ),
      read: (partition, f) => isolated(ensure.pipe(Effect.andThen(f(reader(partition))))),
      due: (now, limit, prefixes) => {
        if (prefixes.length === 0) return Effect.succeed([]);
        const scopes = sql.or(
          prefixes.map((prefix) => {
            const upper = successor(prefix);
            return upper === undefined
              ? sql`part >= ${prefix}`
              : sql`(part >= ${prefix} AND part < ${upper})`;
          }),
        );
        return isolated(
          ensure.pipe(
            Effect.andThen(
              run(
                sql<{
                  part: string;
                  name: string;
                  due: number | string | bigint;
                }>`SELECT part, name, due FROM ${timers} WHERE due <= ${Math.floor(now)} AND ${scopes} ORDER BY due ${sql.literal(`LIMIT ${Math.max(0, Math.floor(limit))}`)}`,
              ),
            ),
            Effect.map((rows) =>
              rows.map((row) => ({ partition: row.part, name: row.name, at: Number(row.due) })),
            ),
          ),
        );
      },
    });
  });

/**
 * Keep a domain in a SQL database, with tables prefixed `options.tablePrefix`.
 * See {@link SqlStorage}.
 */
export const layer = (options: Options = {}): Layer.Layer<Storage, never, SqlClient.SqlClient> =>
  Layer.effect(Storage, make(options));

/**
 * Keep a domain in a SQL database, through the `SqlClient` you provide:
 * Postgres, MySQL or SQLite (including libSQL and Turso). Provide it to
 * `Domain.StoragePlatform`.
 *
 * Three tables hold everything, created on first use: `domain_kv`,
 * `domain_partition` and `domain_timer`. Every transaction locks one
 * partition's row, so any number of processes can host the same domain on
 * one database.
 *
 * ### Hosting on Postgres
 * **Example:** A model on Postgres
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import { PgClient } from "@effect/sql-pg";
 * import * as Config from "effect/Config";
 * import * as Layer from "effect/Layer";
 * import { Bank, BankHandlers } from "./Bank.model.ts";
 *
 * export const BankLive = Bank.layer(BankHandlers).pipe(
 *   Layer.provide(Domain.StoragePlatform),
 *   Layer.provide(Domain.SqlStorage),
 *   Layer.provide(PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })),
 * );
 * ```
 *
 * ### Choosing a table prefix
 * **Example:** Two domains in one database
 * ```typescript
 * import * as SqlStorage from "@alchemy.run/domain/SqlStorage";
 *
 * const BankStorage = SqlStorage.layer({ tablePrefix: "bank" });
 * ```
 *
 * @layer
 * @provides Domain.Storage
 */
export const SqlStorage: Layer.Layer<Storage, never, SqlClient.SqlClient> = layer();
