import type * as postgres from "@distilled.cloud/clickhouse-cloud/postgres";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ResultMissing } from "../Errors.ts";
import type { Service } from "./Service.ts";

/** Which slow query pattern to read, as `ListPostgresSlowQueryPatterns` returns it. */
export interface GetPostgresSlowQueryPatternRequest {
  /** Pattern ID. */
  queryId: string;
  /** Database. */
  dbName: string;
  /** User. */
  dbUser: string;
  /** Operation, e.g. `SELECT`. */
  dbOperation: string;
  /** Application name. */
  app?: string;
  /** Time of one execution, RFC 3339. */
  timestamp?: string;
}

/**
 * Read one slow query pattern of a Postgres service at runtime, with its
 * recent executions. Name it by `queryId`, database, user and operation,
 * as `ListPostgresSlowQueryPatterns` returns them.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:postgres-service:view` on `postgres/*`: ClickHouse grants nothing to a role on one Postgres service's ID, so the key can reach every Postgres service in the organization. ClickHouse Cloud federates no workload identity, so a key
 * is the only way in.
 *
 * ### Using GetPostgresSlowQueryPattern
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
 *     const getSlow = yield* ClickHouseCloud.Postgres.GetPostgresSlowQueryPattern(AppDb);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const detail = yield* getSlow({
 *           queryId: "<queryId>",
 *           dbName: "postgres",
 *           dbUser: "postgres",
 *           dbOperation: "SELECT",
 *         });
 *         return yield* HttpServerResponse.json(detail.recentExecutions.length);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Postgres.GetPostgresSlowQueryPatternHttp)),
 * ) {}
 * ```
 *
 * Uses ClickHouse Cloud API endpoints marked Beta: `getPostgresSlowQueryPattern`.
 *
 * @binding
 * @product Postgres
 */
export interface GetPostgresSlowQueryPattern extends Binding.Service<
  GetPostgresSlowQueryPattern,
  "ClickHouseCloud.Postgres.GetPostgresSlowQueryPattern",
  (
    target: Service,
  ) => Effect.Effect<
    (
      request: GetPostgresSlowQueryPatternRequest,
    ) => Effect.Effect<
      postgres.PostgresSlowQueryPatternDetail,
      postgres.GetPostgresSlowQueryPatternError | ResultMissing,
      RuntimeContext
    >
  >
> {}

export const GetPostgresSlowQueryPattern = Binding.Service<GetPostgresSlowQueryPattern>(
  "ClickHouseCloud.Postgres.GetPostgresSlowQueryPattern",
);
