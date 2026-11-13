import type * as dataQualityMetrics from "@distilled.cloud/starburst-galaxy/data_quality_metrics";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * Read the account's data quality summary: daily pass and fail counts,
 * and counts by catalog, severity and category.
 *
 * The host calls Galaxy as the deploying profile's API client: Galaxy
 * can't mint a key per host or trust a host's identity (see
 * `StarburstGalaxyBindings`), so the client's role bounds what the host
 * may do.
 *
 * ### Calling it from a Worker
 * **Example:** GetDataQualitySummary
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const getDataQualitySummary = yield* StarburstGalaxy.DataQuality.GetDataQualitySummary();
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const summary = yield* getDataQualitySummary();
 *         return yield* HttpServerResponse.json(summary.severityCounts);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(StarburstGalaxy.DataQuality.GetDataQualitySummaryHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product DataQuality
 */
export interface GetDataQualitySummary extends Binding.Service<
  GetDataQualitySummary,
  "StarburstGalaxy.DataQuality.GetDataQualitySummary",
  () => Effect.Effect<
    () => Effect.Effect<
      dataQualityMetrics.DataQualityAccountSummary,
      dataQualityMetrics.GetDataQualitySummaryError,
      RuntimeContext
    >
  >
> {}

export const GetDataQualitySummary = Binding.Service<GetDataQualitySummary>(
  "StarburstGalaxy.DataQuality.GetDataQualitySummary",
);
