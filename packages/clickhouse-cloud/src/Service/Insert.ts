import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";
import type { Service } from "./Service.ts";

/** One batch to insert. */
export interface InsertRequest {
  /** Table, optionally `database.table`. */
  table: string;
  /** Rows as objects keyed by column. */
  values: ReadonlyArray<Record<string, unknown>>;
  /** Columns to fill; omit for all. */
  columns?: string[];
}

/**
 * Insert a batch of rows into a table of a ClickHouse Cloud service at
 * runtime, over the ClickHouse HTTP interface with `@effect/sql-clickhouse`
 * (`JSONEachRow`). Batch rows: ClickHouse prefers few large inserts to many
 * small ones.
 *
 * The host connects as the service's `default` user with the password in
 * the service's state, which reaches the host through `RuntimeContext` as a
 * `Redacted` value: the Cloud API can't create narrower SQL users, so
 * create one with SQL and connect with it yourself when the host must not
 * be an admin. Runs on Node.js hosts; install `@effect/sql-clickhouse` and
 * `@effect/platform-node`. Not on Cloudflare Workers, where the ClickHouse
 * client ends the request with error 1101.
 *
 * ### Inserting Rows
 * **Example:** Record page views
 * ```typescript
 * const insert = yield* ClickHouseCloud.Service.Insert(Analytics);
 * // runtime
 * yield* insert({
 *   table: "events",
 *   values: [{ day: "2026-11-01", path: "/", user_id: 42 }],
 * });
 * ```
 *
 * @binding
 * @product Service
 */
export interface Insert extends Binding.Service<
  Insert,
  "ClickHouseCloud.Service.Insert",
  (
    target: Service,
  ) => Effect.Effect<(request: InsertRequest) => Effect.Effect<void, SqlError, RuntimeContext>>
> {}

export const Insert = Binding.Service<Insert>("ClickHouseCloud.Service.Insert");
