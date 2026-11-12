import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";
import type { SqlCallFailed } from "../Errors.ts";
import type { Service } from "./Service.ts";

/**
 * Run SQL on a ClickHouse Cloud service at runtime and get the rows, over
 * the ClickHouse HTTP interface with `@effect/sql-clickhouse`. Values are
 * passed as typed query parameters (`{name:Type}` placeholders), never
 * spliced into the SQL.
 *
 * The host connects as the service's `default` user with the password in
 * the service's state, which reaches the host through `RuntimeContext` as a
 * `Redacted` value: the Cloud API can't create narrower SQL users, so
 * create one with `CREATE USER` / `GRANT` and connect with it yourself when
 * the host must not be an admin. Runs on Node.js hosts (Lambda, ECS, Fly,
 * containers); install `@effect/sql-clickhouse` and `@effect/platform-node`.
 * Not on Cloudflare Workers: the ClickHouse client's result streams end the
 * request with error 1101 there; use a Query API endpoint and
 * `QueryApiEndpoints.RunQueryApiEndpoint` instead.
 *
 * ### Querying a Service
 * **Example:** Top pages from a Node host
 * ```typescript
 * const query = yield* ClickHouseCloud.Service.Query(Analytics);
 * // runtime
 * const rows = yield* query(
 *   "SELECT path, count() AS hits FROM events WHERE day = {day:Date} GROUP BY path ORDER BY hits DESC LIMIT 10",
 *   { day: "2026-11-01" },
 * );
 * ```
 *
 * @binding
 * @product Service
 */
export interface Query extends Binding.Service<
  Query,
  "ClickHouseCloud.Service.Query",
  (
    target: Service,
  ) => Effect.Effect<
    (
      sql: string,
      params?: Record<string, unknown>,
    ) => Effect.Effect<Array<Record<string, unknown>>, SqlCallFailed | SqlError, RuntimeContext>
  >
> {}

export const Query = Binding.Service<Query>("ClickHouseCloud.Service.Query");
