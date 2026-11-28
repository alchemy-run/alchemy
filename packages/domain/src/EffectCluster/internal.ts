/**
 * Retention on the Effect Cluster host: the sweep that removes the rows
 * only dedupe needs.
 *
 * @internal
 */
import { TABLE } from "@alchemy.run/effect-cluster/ObjectHost";
import * as Clock from "effect/Clock";
import * as MachineId from "effect/cluster/MachineId";
import * as Snowflake from "effect/cluster/Snowflake";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { SqlClient } from "effect/sql/SqlClient";
import {
  type Retention as ObjectRetention,
  retentionMillis,
  retentionWindows,
} from "../DurableObjects.ts";

/** The prefix of Effect Cluster's own tables, as a runner's bootstrap creates them. */
export const CLUSTER_TABLE_PREFIX = "cluster";

const encode = (value: unknown) => JSON.stringify(value ?? null);

/**
 * How long the host keeps rows that only dedupe needs. `"forever"` keeps
 * them.
 */
export interface Retention extends ObjectRetention {
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

/** The windows a sweep applies, in milliseconds; `undefined` keeps rows forever. */
export const windows = (retention: Retention = {}) => ({
  ...retentionWindows(retention),
  messages: retentionMillis(retention.messages, "7 days"),
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
      // A decision's receipt, on the instance that was its primary.
      { prefix: "decided:", window: window.receipts, only: sql`` },
      { prefix: "seen:", window: window.deliveries, only: sql`` },
      { prefix: "scheduled:", window: window.cancelled, only: sql`AND value = ${CANCELLED}` },
    ];
    for (const { prefix, window: kept, only } of kinds) {
      if (kept === undefined) continue;
      // Rows written before the host kept times start their window now.
      yield* sql`UPDATE ${table} SET at = ${now}
        WHERE at IS NULL AND starts_with(object, ${objects}) AND starts_with(key, ${prefix}) ${only}`;
      while (true) {
        // The age and the value are tested on the row again, outside the
        // subquery: a row another transaction wrote while this delete waited
        // for it (a cancelled name armed again) is tested as it is now, and
        // kept. The subquery alone would still name the row it read before.
        const deleted = yield* sql`DELETE FROM ${table} WHERE (object, key) IN (
          SELECT object, key FROM ${table}
          WHERE at < ${now - kept} AND starts_with(object, ${objects}) AND starts_with(key, ${prefix}) ${only}
          LIMIT ${BATCH}
        ) AND at < ${now - kept} ${only} RETURNING key`;
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
