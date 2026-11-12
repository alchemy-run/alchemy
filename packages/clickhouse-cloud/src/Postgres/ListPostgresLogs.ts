import type * as postgres from "@distilled.cloud/clickhouse-cloud/postgres";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ResultMissing } from "../Errors.ts";
import type { Service } from "./Service.ts";

/** A window and filters on the server log. */
export interface ListPostgresLogsRequest {
  /** Start (inclusive), RFC 3339; the window is at most 30 days. */
  fromDate: string;
  /** End (inclusive), RFC 3339. */
  toDate: string;
  /** Case-sensitive text the entry must contain. */
  bodyContains?: string;
  /** `DEBUG`, `LOG`, `INFO`, `NOTICE`, `WARNING`, `ERROR`, `FATAL` or `PANIC`. */
  severity?: postgres.ListPostgresLogsRequestSeverity;
  /** `asc` or `desc`. */
  sortOrder?: "asc" | "desc";
  /** Page size. */
  limit?: number;
  /** Entries to skip. */
  offset?: number;
}

/**
 * Read a Postgres service's server log at runtime, filtered by time window
 * (up to 30 days), severity and text, one page at a time
 * (`limit`/`offset`).
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:postgres-service:view` on `postgres/*`: ClickHouse grants nothing to a role on one Postgres service's ID, so the key can reach every Postgres service in the organization. ClickHouse Cloud federates no workload identity, so a key
 * is the only way in.
 *
 * ### Using ListPostgresLogs
 * **Example:** From a Worker
 * ```typescript
 * export const AppDb = ClickHouseCloud.Postgres.Service("AppDb", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   size: "r6gd.medium",
 * });
 *
 * export default class Ops extends Cloudflare.Worker<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const listLogs = yield* ClickHouseCloud.Postgres.ListPostgresLogs(AppDb);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const errors = yield* listLogs({
 *           fromDate: new Date(Date.now() - 3_600_000).toISOString(),
 *           toDate: new Date().toISOString(),
 *           severity: "ERROR",
 *         });
 *         return yield* HttpServerResponse.json(errors.map((e) => e.body));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Postgres.ListPostgresLogsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Postgres
 */
export interface ListPostgresLogs extends Binding.Service<
  ListPostgresLogs,
  "ClickHouseCloud.Postgres.ListPostgresLogs",
  (
    target: Service,
  ) => Effect.Effect<
    (
      request: ListPostgresLogsRequest,
    ) => Effect.Effect<
      postgres.PostgresLogEntry[],
      postgres.ListPostgresLogsError | ResultMissing,
      RuntimeContext
    >
  >
> {}

export const ListPostgresLogs = Binding.Service<ListPostgresLogs>(
  "ClickHouseCloud.Postgres.ListPostgresLogs",
);
