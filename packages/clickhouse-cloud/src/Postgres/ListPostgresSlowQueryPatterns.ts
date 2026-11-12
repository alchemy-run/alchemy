import type * as postgres from "@distilled.cloud/clickhouse-cloud/postgres";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ResultMissing } from "../Errors.ts";
import type { Service } from "./Service.ts";

/** A window, filters and ordering of slow query patterns. */
export interface ListPostgresSlowQueryPatternsRequest {
  /** Start (inclusive), RFC 3339. */
  fromDate: string;
  /** End (exclusive), RFC 3339. */
  toDate: string;
  /** Database. */
  dbName?: string;
  /** User. */
  dbUser?: string;
  /** Operation, e.g. `SELECT`. */
  dbOperation?: string;
  /** Application name. */
  app?: string;
  /** Field to sort by, e.g. `p95_duration`. */
  sortBy?: postgres.ListPostgresSlowQueryPatternsRequestSortBy;
  /** `asc` or `desc`. */
  sortOrder?: "asc" | "desc";
  /** Page size. */
  limit?: number;
  /** Patterns to skip. */
  offset?: number;
}

/**
 * Read a Postgres service's slowest query patterns at runtime: normalised
 * SQL with call counts and latency percentiles over a time window, one
 * page at a time.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:postgres-service:view` on `postgres/*`: ClickHouse grants nothing to a role on one Postgres service's ID, so the key can reach every Postgres service in the organization. ClickHouse Cloud federates no workload identity, so a key
 * is the only way in.
 *
 * ### Using ListPostgresSlowQueryPatterns
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
 *     const listSlow = yield* ClickHouseCloud.Postgres.ListPostgresSlowQueryPatterns(AppDb);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const slow = yield* listSlow({
 *           fromDate: new Date(Date.now() - 86_400_000).toISOString(),
 *           toDate: new Date().toISOString(),
 *           sortBy: "p95_duration",
 *         });
 *         return yield* HttpServerResponse.json(slow.map((q) => q.queryText));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Postgres.ListPostgresSlowQueryPatternsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Postgres
 */
export interface ListPostgresSlowQueryPatterns extends Binding.Service<
  ListPostgresSlowQueryPatterns,
  "ClickHouseCloud.Postgres.ListPostgresSlowQueryPatterns",
  (
    target: Service,
  ) => Effect.Effect<
    (
      request: ListPostgresSlowQueryPatternsRequest,
    ) => Effect.Effect<
      postgres.PostgresSlowQueryPattern[],
      postgres.ListPostgresSlowQueryPatternsError | ResultMissing,
      RuntimeContext
    >
  >
> {}

export const ListPostgresSlowQueryPatterns = Binding.Service<ListPostgresSlowQueryPatterns>(
  "ClickHouseCloud.Postgres.ListPostgresSlowQueryPatterns",
);
