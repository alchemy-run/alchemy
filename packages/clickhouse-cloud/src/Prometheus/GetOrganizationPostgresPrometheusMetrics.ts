import type * as prometheus from "@distilled.cloud/clickhouse-cloud/prometheus";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Organization } from "../Organization/Organization.ts";

/**
 * Scrape the metrics of every Postgres service in the organization (up to
 * 100) at runtime, in the Prometheus text format. The endpoint is in beta.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:organization:view` on the organization. ClickHouse Cloud federates no workload identity, so a key
 * is the only way in.
 *
 * ### Using GetOrganizationPostgresPrometheusMetrics
 * **Example:** From a Worker
 * ```typescript
 * export const Org = ClickHouseCloud.Organization.Organization("Org", {});
 *
 * export default class Ops extends Cloudflare.Worker<Ops>()(
 *   "Ops",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const scrape = yield* ClickHouseCloud.Prometheus.GetOrganizationPostgresPrometheusMetrics(Org);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime
 *         const text = yield* scrape();
 *         return yield* HttpServerResponse.text(text);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Prometheus.GetOrganizationPostgresPrometheusMetricsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Prometheus
 */
export interface GetOrganizationPostgresPrometheusMetrics extends Binding.Service<
  GetOrganizationPostgresPrometheusMetrics,
  "ClickHouseCloud.Prometheus.GetOrganizationPostgresPrometheusMetrics",
  (
    target: Organization,
  ) => Effect.Effect<
    () => Effect.Effect<
      string,
      prometheus.GetOrganizationPostgresPrometheusMetricsError,
      RuntimeContext
    >
  >
> {}

export const GetOrganizationPostgresPrometheusMetrics =
  Binding.Service<GetOrganizationPostgresPrometheusMetrics>(
    "ClickHouseCloud.Prometheus.GetOrganizationPostgresPrometheusMetrics",
  );
