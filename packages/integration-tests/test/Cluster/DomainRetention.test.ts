/**
 * Retention of the Domain host on Effect Cluster, against a real Postgres.
 * Runs only when its database URL is set:
 *
 *   DOMAIN_TEST_POSTGRES_URL=postgres://postgres@localhost:5432/domain_test
 *
 * It drops and makes again `alchemy_domain_objects`, the schema `domain`
 * and the `cluster_*` tables of that database. Each case runs on the
 * default table, and again on a table in its own schema.
 */
import {
  CLUSTER_TABLE_PREFIX,
  objectStorage,
  migrate,
  type Storage,
  sweep,
  tableOf,
} from "@alchemy.run/domain/EffectCluster/internal";
import { describe, expect, it } from "@alchemy.run/test";
import { PgClient } from "@effect/sql-pg";
import { makeInputGate } from "alchemy/Workers/InputGate";
import * as Clock from "effect/Clock";
import * as MachineId from "effect/cluster/MachineId";
import * as Snowflake from "effect/cluster/Snowflake";
import * as SqlMessageStorage from "effect/cluster/SqlMessageStorage";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { SqlClient } from "effect/sql/SqlClient";

const URL = process.env.DOMAIN_TEST_POSTGRES_URL;

const DAY = 24 * 60 * 60 * 1000;
/** Times are set from here: Effect Cluster's snowflakes start in 2025. */
const T0 = Date.UTC(2026, 0, 1);

/** Where each run of the suite keeps the host's table. */
const LAYOUTS: ReadonlyArray<readonly [string, Storage]> = [
  ["the default table", {}],
  ["a table in its own schema", { schema: "domain", table: "domain_objects" }],
];

const drop = (storage: Storage) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const { schema, qualified } = tableOf(storage);
    yield* sql`DROP TABLE IF EXISTS ${sql(qualified)}`;
    if (schema !== undefined) yield* sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
    for (const table of ["messages", "replies", "migrations"])
      yield* sql`DROP TABLE IF EXISTS ${sql(`${CLUSTER_TABLE_PREFIX}_${table}`)}`;
  }).pipe(Effect.orDie);

/** A fresh database for one test: the host's table, and Effect Cluster's message tables. */
const Database = (storage: Storage) =>
  SqlMessageStorage.layerMigrations({ prefix: CLUSTER_TABLE_PREFIX }).pipe(
    Layer.provideMerge(
      Layer.effectDiscard(
        Effect.acquireRelease(
          Effect.andThen(
            drop(storage),
            Effect.flatMap(SqlClient, (sql) => migrate(sql, storage)),
          ),
          () => drop(storage),
        ),
      ),
    ),
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(URL ?? ""), maxConnections: 2 })),
  );

/**
 * The time the host reads, set by each test. Sleeps stay real: the
 * Postgres driver waits on them, so `TestClock` would hold every query.
 */
const now = { millis: 0 };
const setTime = (millis: number) =>
  Effect.sync(() => {
    now.millis = millis;
  });

/** Run a test on a fresh database, at the time it sets. */
const onDatabase =
  (storage: Storage) =>
  <A, E, R>(test: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const live = yield* Clock.Clock;
      const clock: Clock.Clock = {
        ...live,
        currentTimeMillisUnsafe: () => now.millis,
        currentTimeMillis: Effect.sync(() => now.millis),
        currentTimeNanosUnsafe: () => BigInt(now.millis) * 1_000_000n,
        currentTimeNanos: Effect.sync(() => BigInt(now.millis) * 1_000_000n),
        sleep: (duration) => live.sleep(duration),
      };
      return yield* test.pipe(
        Effect.provide(Database(storage)),
        Effect.provideService(Clock.Clock, clock),
      );
    });

/** One instance's storage, as the host gives it to an entity id. */
const storageOf = (object: string, storage: Storage) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return objectStorage(sql, object, yield* makeInputGate, storage);
  });

const keysOf = (object: string, storage: Storage) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{
      key: string;
    }>`SELECT key FROM ${sql(tableOf(storage).qualified)} WHERE object = ${object} ORDER BY key`;
    return rows.map((row) => row.key);
  });

/** A processed message to `entity`, made at `at`, with its reply; or one still waiting. */
const message = (entity: string, at: number, sequence: number, processed = true) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const id = String(Snowflake.make({ timestamp: at, machineId: MachineId.make(1), sequence }));
    const reply = String(
      Snowflake.make({ timestamp: at, machineId: MachineId.make(1), sequence: sequence + 2048 }),
    );
    yield* sql`INSERT INTO ${sql(`${CLUSTER_TABLE_PREFIX}_messages`)}
      (id, message_id, shard_id, entity_type, entity_id, kind, tag, payload, processed, request_id, last_reply_id)
      VALUES (${id}, ${`${entity}/${id}`}, 'default:1', ${entity}, 'a', 0, 'Wake', '{}', ${processed}, ${id}, ${processed ? reply : null})`;
    if (processed)
      yield* sql`INSERT INTO ${sql(`${CLUSTER_TABLE_PREFIX}_replies`)} (id, kind, request_id, payload)
        VALUES (${reply}, 0, ${id}, '{}')`;
    return id;
  });

const messagesLeft = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const messages = yield* sql<{
    id: string;
  }>`SELECT id::text AS id FROM ${sql(`${CLUSTER_TABLE_PREFIX}_messages`)} ORDER BY id`;
  const replies = yield* sql<{
    request: string;
  }>`SELECT request_id::text AS request FROM ${sql(`${CLUSTER_TABLE_PREFIX}_replies`)} ORDER BY request_id`;
  return { messages: messages.map((row) => row.id), replies: replies.map((row) => row.request) };
});

for (const [layout, storage] of LAYOUTS)
  describe.skipIf(URL === undefined)(
    `Domain on Effect Cluster: retention, on ${layout}`,
    { tags: ["local"] },
    () => {
      it.live(
        "each kind of dedupe row is deleted once it is older than its window",
        () =>
          Effect.gen(function* () {
            yield* setTime(T0);
            const sql = yield* SqlClient;
            const counter = yield* storageOf("Bank/Bank.CounterAggregate/a", storage);
            yield* counter.put({
              "event:000000000001": { n: 1 },
              meta: { version: 1 },
              "receipt:c-1": { _tag: "Accepted" },
              "scheduled:pending": "token-1",
              "scheduled:dropped": "cancelled",
            });
            const policy = yield* storageOf("Bank/Bank.WelcomePolicy/a", storage);
            yield* policy.put("seen:Counter/a:1", true);
            // Another model's entity on the same database keeps its rows.
            const other = yield* storageOf("Other/Other.CounterAggregate/a", storage);
            yield* other.put({ "receipt:c-1": { _tag: "Accepted" }, "seen:x:1": true });
            const old = yield* message("Bank", T0, 1);
            const waiting = yield* message("Bank", T0, 2, false);
            const saga = yield* message("Workflow/Transfer", T0, 3);
            const others = yield* message("Other", T0, 4);

            // Nothing has outlived its window yet.
            yield* setTime(T0 + 7 * DAY);
            yield* sweep(sql, "Bank", {}, storage);
            expect(yield* keysOf("Bank/Bank.WelcomePolicy/a", storage)).toEqual([
              "seen:Counter/a:1",
            ]);
            expect((yield* messagesLeft).messages).toContain(old);

            // A week on: the delivery marks, the cancelled command and the processed message go.
            yield* setTime(T0 + 7 * DAY + 1);
            const fresh = yield* message("Bank", T0 + 7 * DAY, 5);
            yield* sweep(sql, "Bank", {}, storage);
            expect(yield* keysOf("Bank/Bank.WelcomePolicy/a", storage)).toEqual([]);
            expect(yield* keysOf("Bank/Bank.CounterAggregate/a", storage)).toEqual([
              "event:000000000001",
              "meta",
              "receipt:c-1",
              "scheduled:pending",
            ]);
            expect(yield* messagesLeft).toEqual({
              messages: [waiting, saga, others, fresh].sort(),
              replies: [saga, others, fresh].sort(),
            });
            expect(yield* keysOf("Other/Other.CounterAggregate/a", storage)).toEqual([
              "receipt:c-1",
              "seen:x:1",
            ]);

            // Thirty days on: the receipt goes too; events and state stay.
            yield* setTime(T0 + 30 * DAY + 1);
            yield* sweep(sql, "Bank", {}, storage);
            expect(yield* keysOf("Bank/Bank.CounterAggregate/a", storage)).toEqual([
              "event:000000000001",
              "meta",
              "scheduled:pending",
            ]);
          }).pipe(onDatabase(storage)),
        { timeout: 60_000 },
      );

      it.live(
        "a row written again starts its window again",
        () =>
          Effect.gen(function* () {
            yield* setTime(T0);
            const sql = yield* SqlClient;
            const timer = yield* storageOf("Bank/Bank.HoldAggregate/h", storage);
            yield* timer.put("scheduled:expire", "token-1");
            // Cancelled six days later: its week starts then.
            yield* setTime(T0 + 6 * DAY);
            yield* timer.put("scheduled:expire", "cancelled");
            yield* setTime(T0 + 8 * DAY);
            yield* sweep(sql, "Bank", {}, storage);
            expect(yield* keysOf("Bank/Bank.HoldAggregate/h", storage)).toEqual([
              "scheduled:expire",
            ]);
            yield* setTime(T0 + 13 * DAY + 1);
            yield* sweep(sql, "Bank", {}, storage);
            expect(yield* keysOf("Bank/Bank.HoldAggregate/h", storage)).toEqual([]);
          }).pipe(onDatabase(storage)),
        { timeout: 60_000 },
      );

      it.live(
        "rows from before the host kept times age from the first sweep",
        () =>
          Effect.gen(function* () {
            yield* setTime(T0);
            const sql = yield* SqlClient;
            // The table as an earlier host made it, with no times.
            const TABLE = tableOf(storage).qualified;
            yield* sql`DROP TABLE ${sql(TABLE)}`;
            yield* sql`CREATE TABLE ${sql(TABLE)} (
            object TEXT COLLATE "C" NOT NULL,
            key TEXT COLLATE "C" NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (object, key)
          )`;
            yield* sql`INSERT INTO ${sql(TABLE)} (object, key, value) VALUES ('Bank/Bank.WelcomePolicy/a', 'seen:Counter/a:1', 'true')`;
            // A newer runner starts on it, twice at once.
            yield* Effect.all([migrate(sql, storage), migrate(sql, storage)], { concurrency: 2 });
            yield* setTime(T0 + 100 * DAY);
            yield* sweep(sql, "Bank", {}, storage);
            expect(yield* keysOf("Bank/Bank.WelcomePolicy/a", storage)).toEqual([
              "seen:Counter/a:1",
            ]);
            yield* setTime(T0 + 107 * DAY + 1);
            yield* sweep(sql, "Bank", {}, storage);
            expect(yield* keysOf("Bank/Bank.WelcomePolicy/a", storage)).toEqual([]);
          }).pipe(onDatabase(storage)),
        { timeout: 60_000 },
      );

      it.live(
        "a window of forever keeps that kind of row",
        () =>
          Effect.gen(function* () {
            yield* setTime(T0);
            const sql = yield* SqlClient;
            const counter = yield* storageOf("Bank/Bank.CounterAggregate/a", storage);
            yield* counter.put({
              "receipt:c-1": { _tag: "Accepted" },
              "scheduled:dropped": "cancelled",
            });
            const old = yield* message("Bank", T0, 1);
            yield* setTime(T0 + 365 * DAY);
            yield* sweep(
              sql,
              "Bank",
              { receipts: "forever", cancelled: "forever", messages: "forever" },
              storage,
            );
            expect(yield* keysOf("Bank/Bank.CounterAggregate/a", storage)).toEqual([
              "receipt:c-1",
              "scheduled:dropped",
            ]);
            expect((yield* messagesLeft).messages).toEqual([old]);
          }).pipe(onDatabase(storage)),
        { timeout: 60_000 },
      );

      it.live(
        "many expired rows go in several batches",
        () =>
          Effect.gen(function* () {
            yield* setTime(T0);
            const sql = yield* SqlClient;
            const policy = yield* storageOf("Bank/Bank.WelcomePolicy/a", storage);
            const marks: Record<string, boolean> = {};
            for (let i = 0; i < 2_500; i++) marks[`seen:Counter/a:${i}`] = true;
            yield* policy.put(marks);
            for (let i = 0; i < 1_200; i++) yield* message("Bank", T0, i);
            yield* setTime(T0 + 8 * DAY);
            yield* sweep(sql, "Bank", {}, storage);
            expect(yield* keysOf("Bank/Bank.WelcomePolicy/a", storage)).toEqual([]);
            expect(yield* messagesLeft).toEqual({ messages: [], replies: [] });
          }).pipe(onDatabase(storage)),
        { timeout: 120_000 },
      );
    },
  );

describe.skipIf(URL === undefined)(
  "Domain on Effect Cluster: where the table lives",
  { tags: ["local"] },
  () => {
    const inSchema: Storage = { schema: "domain", table: "domain_objects" };

    it.live(
      "the schema, its table and its index are made when missing; the default table is left alone",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* drop(inSchema);
          yield* drop({});
          // Runners start together.
          yield* Effect.all([migrate(sql, inSchema), migrate(sql, inSchema)], {
            concurrency: 2,
          });
          const tables = yield* sql<{ schema: string; name: string }>`
            SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
            WHERE table_name IN ('domain_objects', 'alchemy_domain_objects')`;
          expect(tables).toEqual([{ schema: "domain", name: "domain_objects" }]);
          const indexes = yield* sql<{ name: string }>`
            SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'domain' ORDER BY indexname`;
          expect(indexes.map((row) => row.name)).toEqual([
            "domain_objects_at",
            "domain_objects_pkey",
          ]);
          yield* drop(inSchema);
        }).pipe(
          Effect.provide(PgClient.layer({ url: Redacted.make(URL ?? ""), maxConnections: 2 })),
        ),
      { timeout: 60_000 },
    );
  },
);

describe("Domain on Effect Cluster: storage names", { tags: ["unit"] }, () => {
  it("a name with a dot is refused", () => {
    expect(() => tableOf({ schema: "a.b" })).toThrow(/schema 'a.b'/);
    expect(() => tableOf({ table: "" })).toThrow(/table ''/);
    expect(tableOf({})).toEqual({
      schema: undefined,
      table: "alchemy_domain_objects",
      qualified: "alchemy_domain_objects",
    });
  });
});
