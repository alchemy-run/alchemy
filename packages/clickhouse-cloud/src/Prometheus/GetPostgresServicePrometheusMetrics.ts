import type * as prometheus from "@distilled.cloud/clickhouse-cloud/prometheus";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Service as PostgresService } from "../Postgres/Service.ts";

/**
 * Scrape a Postgres service's metrics at runtime in the Prometheus text
 * format, e.g. to relay them to your own Prometheus. The endpoint is in
 * beta.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:postgres-service:view` on the bound Postgres service. ClickHouse Cloud federates no workload identity, so a key
 * is the only way in.
 *
 * ### Using GetPostgresServicePrometheusMetrics
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
 *     const scrape = yield* ClickHouseCloud.Prometheus.GetPostgresServicePrometheusMetrics(AppDb);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const text = yield* scrape();
 *         return yield* HttpServerResponse.text(text);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Prometheus.GetPostgresServicePrometheusMetricsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Prometheus
 */
export interface GetPostgresServicePrometheusMetrics extends Binding.Service<
  GetPostgresServicePrometheusMetrics,
  "ClickHouseCloud.Prometheus.GetPostgresServicePrometheusMetrics",
  (
    target: PostgresService,
  ) => Effect.Effect<
    () => Effect.Effect<string, prometheus.GetPostgresServicePrometheusMetricsError, RuntimeContext>
  >
> {}

export const GetPostgresServicePrometheusMetrics =
  Binding.Service<GetPostgresServicePrometheusMetrics>(
    "ClickHouseCloud.Prometheus.GetPostgresServicePrometheusMetrics",
  );
