/**
 * Storage and retention of the Effect Cluster host: where each instance
 * keeps its keys, and the sweep that removes the rows only dedupe needs.
 *
 * @internal
 */
import type { InputGateShape } from "alchemy/Workers/InputGate";
import * as Clock from "effect/Clock";
import * as MachineId from "effect/cluster/MachineId";
import * as Snowflake from "effect/cluster/Snowflake";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { SqlClient } from "effect/sql/SqlClient";
import type { ListOptions, ObjectStorage } from "../DurableObjects.ts";

/** Where every instance keeps its storage: one row per key, in the cluster's database. */
export const TABLE = "alchemy_domain_objects";

/** The prefix of Effect Cluster's own tables, as a runner's bootstrap creates them. */
export const CLUSTER_TABLE_PREFIX = "cluster";

const encode = (value: unknown) => JSON.stringify(value ?? null);
const decode = <T>(text: string) => JSON.parse(text) as T;

/**
 * Domain's storage for one entity id over the cluster's Postgres. Every
 * operation goes through the instance's input gate, as on Cloudflare. Each
 * row keeps when it was last written (`at`), for retention.
 */
export const objectStorage = (
  sql: SqlClient,
  object: string,
  gate: InputGateShape,
): ObjectStorage => {
  const run = <A>(effect: Effect.Effect<A, unknown>) => gate.storage(Effect.orDie(effect));
  const putOne = (key: string, value: unknown, at: number) =>
    sql`INSERT INTO ${sql(TABLE)} (object, key, value, at) VALUES (${object}, ${key}, ${encode(value)}, ${at})
        ON CONFLICT (object, key) DO UPDATE SET value = excluded.value, at = excluded.at`;
  return {
    get: <T>(key: string) =>
      run(
        sql<{
          value: string;
        }>`SELECT value FROM ${sql(TABLE)} WHERE object = ${object} AND key = ${key}`.pipe(
          Effect.map((rows) => (rows[0] === undefined ? undefined : decode<T>(rows[0].value))),
        ),
      ),
    put: ((keyOrEntries: string | Record<string, unknown>, value?: unknown) =>
      run(
        Effect.flatMap(Clock.currentTimeMillis, (at) =>
          typeof keyOrEntries === "string"
            ? Effect.asVoid(putOne(keyOrEntries, value, at))
            : Effect.forEach(
                Object.entries(keyOrEntries),
                ([key, entry]) => putOne(key, entry, at),
                { discard: true },
              ),
        ),
      )) as ObjectStorage["put"],
    delete: ((keyOrKeys: string | ReadonlyArray<string>) => {
      const keys = typeof keyOrKeys === "string" ? [keyOrKeys] : keyOrKeys;
      const deleted =
        keys.length === 0
          ? Effect.succeed(0)
          : sql<{
              key: string;
            }>`DELETE FROM ${sql(TABLE)} WHERE object = ${object} AND ${sql.in("key", keys)} RETURNING key`.pipe(
              Effect.map((rows) => rows.length),
            );
      return run<number | boolean>(
        typeof keyOrKeys === "string" ? Effect.map(deleted, (n) => n > 0) : deleted,
      );
    }) as ObjectStorage["delete"],
    list: <T>({ prefix, start, startAfter, end, limit }: ListOptions = {}) =>
      run(
        sql<{ key: string; value: string }>`SELECT key, value FROM ${sql(TABLE)}
          WHERE object = ${object}
          ${prefix ? sql`AND starts_with(key, ${prefix})` : sql``}
          ${start !== undefined ? sql`AND key >= ${start}` : sql``}
          ${startAfter !== undefined ? sql`AND key > ${startAfter}` : sql``}
          ${end !== undefined ? sql`AND key < ${end}` : sql``}
          ORDER BY key
          ${limit !== undefined ? sql`LIMIT ${Math.max(0, limit | 0)}` : sql``}`.pipe(
          Effect.map((rows) => new Map(rows.map((row) => [row.key, decode<T>(row.value)]))),
        ),
      ),
    // Held across the whole transaction, as Cloudflare's gate is.
    transaction: (effect) =>
      gate.exclusive(sql.withTransaction(effect).pipe(Effect.orDie)) as never,
  };
};

/**
 * Create the storage table, or add what a newer host needs to it. Runners
 * start together, so one at a time: the others wait on the lock.
 */
export const migrate = (sql: SqlClient) =>
  sql
    .withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT pg_advisory_xact_lock(hashtext(${TABLE}))`;
        yield* sql`CREATE TABLE IF NOT EXISTS ${sql(TABLE)} (
          object TEXT COLLATE "C" NOT NULL,
          key TEXT COLLATE "C" NOT NULL,
          value TEXT NOT NULL,
          at BIGINT,
          PRIMARY KEY (object, key)
        )`;
        // A table made by an earlier host: its rows have no time yet; the
        // first sweep gives them one.
        yield* sql`ALTER TABLE ${sql(TABLE)} ADD COLUMN IF NOT EXISTS at BIGINT`;
        yield* sql`CREATE INDEX IF NOT EXISTS ${sql(`${TABLE}_at`)} ON ${sql(TABLE)} (at)`;
      }),
    )
    .pipe(Effect.orDie);

/**
 * How long the host keeps rows that only dedupe needs. `"forever"` keeps
 * them.
 */
export interface Retention {
  /**
   * Receipts of accepted commands. A command sent again after this time is
   * decided again.
   * @default "30 days"
   */
  readonly receipts?: Duration.Input | "forever";
  /**
   * The marks that a policy instance ran a delivery. A delivery that arrives
   * again after this time runs again.
   * @default "7 days"
   */
  readonly deliveries?: Duration.Input | "forever";
  /**
   * Cancelled scheduled commands. After this time, `unschedule` answers
   * `NotScheduled` instead of `AlreadyCancelled`.
   * @default "7 days"
   */
  readonly cancelled?: Duration.Input | "forever";
  /**
   * Processed cluster messages to the host's entity (its persisted wakes)
   * and their replies. Effect Cluster never deletes them. Saga messages are
   * left to the workflow engine.
   * @default "7 days"
   */
  readonly messages?: Duration.Input | "forever";
  /**
   * How often each runner sweeps.
   * @default "1 hour"
   */
  readonly interval?: Duration.Input;
}

/** Rows one sweep statement deletes at a time. */
const BATCH = 1_000;

const millis = (value: Duration.Input | "forever" | undefined, fallback: Duration.Input) => {
  if (value === "forever") return undefined;
  const duration = Duration.fromInputUnsafe(value ?? fallback);
  return Duration.isFinite(duration) ? Duration.toMillis(duration) : undefined;
};

/** The windows a sweep applies, in milliseconds; `undefined` keeps rows forever. */
export const windows = (retention: Retention = {}) => ({
  receipts: millis(retention.receipts, "30 days"),
  deliveries: millis(retention.deliveries, "7 days"),
  cancelled: millis(retention.cancelled, "7 days"),
  messages: millis(retention.messages, "7 days"),
});

/** The value of `scheduled:<name>` once that command is cancelled, as stored. */
const CANCELLED = encode("cancelled");

/**
 * Delete the rows of the host entity `entity` that `retention` no longer
 * keeps. Safe to run on every runner at once.
 */
export const sweep = (sql: SqlClient, entity: string, retention: Retention = {}) =>
  Effect.gen(function* () {
    const window = windows(retention);
    const now = yield* Clock.currentTimeMillis;
    const objects = `${entity}/`;
    const table = sql(TABLE);
    const kinds = [
      { prefix: "receipt:", window: window.receipts, only: sql`` },
      { prefix: "seen:", window: window.deliveries, only: sql`` },
      { prefix: "scheduled:", window: window.cancelled, only: sql`AND value = ${CANCELLED}` },
    ];
    for (const { prefix, window: kept, only } of kinds) {
      if (kept === undefined) continue;
      // Rows written before the host kept times start their window now.
      yield* sql`UPDATE ${table} SET at = ${now}
        WHERE at IS NULL AND starts_with(object, ${objects}) AND starts_with(key, ${prefix}) ${only}`;
      while (true) {
        const deleted = yield* sql`DELETE FROM ${table} WHERE (object, key) IN (
          SELECT object, key FROM ${table}
          WHERE at < ${now - kept} AND starts_with(object, ${objects}) AND starts_with(key, ${prefix}) ${only}
          LIMIT ${BATCH}
        ) RETURNING key`;
        if (deleted.length < BATCH) break;
      }
    }
    if (window.messages !== undefined) {
      // Message ids are snowflakes: the time each was made is in its high bits.
      const before = String(
        Snowflake.make({
          timestamp: now - window.messages,
          machineId: MachineId.make(0),
          sequence: 0,
        }),
      );
      const messages = sql(`${CLUSTER_TABLE_PREFIX}_messages`);
      const replies = sql(`${CLUSTER_TABLE_PREFIX}_replies`);
      // One locked set of ids per transaction, and both deletes on exactly
      // that set: a message is never deleted with its reply left behind.
      const batch = sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ id: string }>`SELECT id::text AS id FROM ${messages}
            WHERE id < ${before} AND processed = TRUE AND entity_type = ${entity}
            ORDER BY id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`;
          if (rows.length === 0) return 0;
          const ids = rows.map((row) => row.id);
          yield* sql`DELETE FROM ${replies} WHERE ${sql.in("request_id", ids)}`;
          yield* sql`DELETE FROM ${messages} WHERE ${sql.in("id", ids)}`;
          return rows.length;
        }),
      );
      while ((yield* batch) === BATCH) {}
    }
  });
