import type * as postgres from "@distilled.cloud/clickhouse-cloud/postgres";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ResultMissing } from "../Errors.ts";
import type { Service } from "./Service.ts";

/** The window of a metrics read. */
export interface GetPostgresServiceMetricsRequest {
  /** Start (inclusive), RFC 3339. */
  fromDate: string;
  /** End (exclusive), RFC 3339. */
  toDate: string;
  /** Bucket size in seconds; derived from the window when omitted (at most 250 points). */
  bucketSizeSeconds?: number;
}

/**
 * Read a Postgres service's metrics at runtime: CPU, memory, connections,
 * I/O, as time series of up to 250 points between two RFC 3339 times.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:postgres-service:view` on `postgres/*`: ClickHouse grants nothing to a role on one Postgres service's ID, so the key can reach every Postgres service in the organization. ClickHouse Cloud federates no workload identity, so a key
 * is the only way in.
 *
 * ### Using GetPostgresServiceMetrics
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
 *     const getMetrics = yield* ClickHouseCloud.Postgres.GetPostgresServiceMetrics(AppDb);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const metrics = yield* getMetrics({
 *           fromDate: new Date(Date.now() - 3_600_000).toISOString(),
 *           toDate: new Date().toISOString(),
 *         });
 *         return yield* HttpServerResponse.json(metrics.metrics.map((m) => m.key));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Postgres.GetPostgresServiceMetricsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Postgres
 */
export interface GetPostgresServiceMetrics extends Binding.Service<
  GetPostgresServiceMetrics,
  "ClickHouseCloud.Postgres.GetPostgresServiceMetrics",
  (
    target: Service,
  ) => Effect.Effect<
    (
      request: GetPostgresServiceMetricsRequest,
    ) => Effect.Effect<
      postgres.PostgresMetrics,
      postgres.GetPostgresServiceMetricsError | ResultMissing,
      RuntimeContext
    >
  >
> {}

export const GetPostgresServiceMetrics = Binding.Service<GetPostgresServiceMetrics>(
  "ClickHouseCloud.Postgres.GetPostgresServiceMetrics",
);
