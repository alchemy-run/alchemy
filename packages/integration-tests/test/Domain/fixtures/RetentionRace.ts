/**
 * Retention cases that need exact interleavings, made with triggers on the
 * cluster's tables (SQLite, Postgres, MySQL/MariaDB). Run them on a host with
 * `retention.messages: 0` and a short sweep interval. Message rows use the
 * shard id `unowned:1`, so no runner delivers them.
 */
import { expect } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { eventually } from "./HostContract.ts";

export interface RaceTables {
  /** The cluster's message table, e.g. `cluster_messages`. */
  readonly messages: string;
  /** The cluster's reply table, e.g. `cluster_replies`. */
  readonly replies: string;
  /** A prefix for trigger and function names (they are global on some databases). */
  readonly name: string;
}

const flag = (sql: SqlClient.SqlClient, value: boolean) =>
  sql.onDialectOrElse({
    pg: () => sql.literal(value ? "TRUE" : "FALSE"),
    orElse: () => sql.literal(value ? "1" : "0"),
  });

/** Run a trigger body when a row is deleted, on every dialect. */
const createTrigger = (
  sql: SqlClient.SqlClient,
  name: string,
  timing: "BEFORE" | "AFTER",
  table: string,
  when: string,
  body: { readonly sqlite: string; readonly pg: string; readonly mysql: string },
) =>
  sql.onDialectOrElse({
    pg: () =>
      sql
        .unsafe(
          `CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger AS $$ BEGIN IF ${when} THEN ${body.pg} END IF; RETURN OLD; END $$ LANGUAGE plpgsql`,
        )
        .pipe(
          Effect.andThen(
            sql.unsafe(
              `CREATE TRIGGER ${name} ${timing} DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
            ),
          ),
        ),
    mysql: () =>
      sql.unsafe(
        `CREATE TRIGGER ${name} ${timing} DELETE ON ${table} FOR EACH ROW BEGIN IF ${when} THEN ${body.mysql} END IF; END`,
      ),
    orElse: () =>
      sql.unsafe(
        `CREATE TRIGGER ${name} ${timing} DELETE ON ${table} WHEN ${when} BEGIN ${body.sqlite} END`,
      ),
  });

const dropTrigger = (sql: SqlClient.SqlClient, name: string, table: string) =>
  sql.onDialectOrElse({
    pg: () =>
      sql
        .unsafe(`DROP TRIGGER IF EXISTS ${name} ON ${table}`)
        .pipe(Effect.andThen(sql.unsafe(`DROP FUNCTION IF EXISTS ${name}()`))),
    orElse: () => sql.unsafe(`DROP TRIGGER IF EXISTS ${name}`),
  });

/** Insert old message rows of `type` (and replies) in one transaction, so no sweep sees half of them. */
const insert = (
  sql: SqlClient.SqlClient,
  t: RaceTables,
  type: string,
  messages: ReadonlyArray<{ readonly id: number; readonly processed: boolean }>,
  replies: ReadonlyArray<number>,
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      for (const { id, processed } of messages)
        yield* sql`INSERT INTO ${sql(t.messages)} (id, shard_id, entity_type, entity_id, kind, processed, request_id) VALUES (${id}, 'unowned:1', ${type}, ${`probe-${id}`}, 0, ${flag(sql, processed)}, ${id})`;
      for (const id of replies)
        yield* sql`INSERT INTO ${sql(t.replies)} (id, kind, request_id, payload) VALUES (${id}, 0, ${id}, '{}')`;
    }),
  );

const ids = (sql: SqlClient.SqlClient, table: string, column: string, of: ReadonlyArray<number>) =>
  sql<{
    id: number | string;
  }>`SELECT ${sql(column)} AS id FROM ${sql(table)} WHERE ${sql.in(column, of)} ORDER BY ${sql(column)}`.pipe(
    Effect.map((rows) => rows.map((row) => Number(row.id))),
  );

/**
 * A pending request (2) completes while the sweep deletes an old processed
 * one (1): a trigger marks it processed during the delete of reply 1. It was
 * not in the set the sweep chose, so it keeps its message row; its reply
 * comes after, and the next sweep deletes both. No reply is left without its
 * message.
 */
export const concurrentCompletion = (t: RaceTables, type: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const trigger = `${t.name}_complete`;
    yield* createTrigger(sql, trigger, "AFTER", t.replies, "OLD.request_id = 1", {
      sqlite: `UPDATE ${t.messages} SET processed = 1 WHERE id = 2;`,
      pg: `UPDATE ${t.messages} SET processed = TRUE WHERE id = 2;`,
      mysql: `UPDATE ${t.messages} SET processed = 1 WHERE id = 2;`,
    });
    yield* Effect.gen(function* () {
      yield* insert(
        sql,
        t,
        type,
        [
          { id: 1, processed: true },
          { id: 2, processed: false },
        ],
        [1],
      );
      yield* eventually(
        ids(sql, t.messages, "id", [1]).pipe(
          Effect.filterOrFail(
            (left) => left.length === 0,
            () => "not yet" as const,
          ),
        ),
      );
      // Request 2 completed during that sweep: it keeps its message row.
      expect(yield* ids(sql, t.messages, "id", [2])).toEqual([2]);
      expect(yield* ids(sql, t.replies, "request_id", [1])).toEqual([]);
      // Its reply lands; the next sweep deletes the message and the reply together.
      yield* insert(sql, t, type, [], [2]);
      yield* eventually(
        Effect.all([ids(sql, t.messages, "id", [2]), ids(sql, t.replies, "request_id", [2])]).pipe(
          Effect.filterOrFail(
            ([messages, replies]) => messages.length === 0 && replies.length === 0,
            () => "not yet" as const,
          ),
        ),
      );
    }).pipe(Effect.ensuring(dropTrigger(sql, trigger, t.replies).pipe(Effect.ignore)));
  });

/**
 * The delete of the messages fails after the delete of their replies: the
 * whole batch rolls back, so the reply stays with its message. Once the
 * failure is gone, a sweep deletes both.
 */
export const rollbackBetweenDeletes = (t: RaceTables, type: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const trigger = `${t.name}_fail`;
    yield* createTrigger(sql, trigger, "BEFORE", t.messages, "OLD.id = 3", {
      sqlite: `SELECT RAISE(ABORT, 'retention probe');`,
      pg: `RAISE EXCEPTION 'retention probe';`,
      mysql: `SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'retention probe';`,
    });
    const both = Effect.all([
      ids(sql, t.messages, "id", [3]),
      ids(sql, t.replies, "request_id", [3]),
    ]);
    yield* Effect.gen(function* () {
      yield* insert(sql, t, type, [{ id: 3, processed: true }], [3]);
      // Several sweeps fail on the message delete; each rolls back its reply delete.
      yield* Effect.sleep("800 millis");
      expect(yield* both).toEqual([[3], [3]]);
    }).pipe(Effect.ensuring(dropTrigger(sql, trigger, t.messages).pipe(Effect.ignore)));
    yield* eventually(
      both.pipe(
        Effect.filterOrFail(
          ([messages, replies]) => messages.length === 0 && replies.length === 0,
          () => "not yet" as const,
        ),
      ),
    );
  });
