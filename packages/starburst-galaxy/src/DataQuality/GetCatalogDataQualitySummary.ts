import type * as dataQualityMetrics from "@distilled.cloud/starburst-galaxy/data_quality_metrics";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";

/**
 * Read the bound catalog's data quality summary: daily pass and fail
 * counts, and counts by schema, severity and category.
 *
 * The host calls Galaxy as the deploying profile's API client: Galaxy
 * can't mint a key per host or trust a host's identity (see
 * `StarburstGalaxyBindings`), so the client's role bounds what the host
 * may do.
 *
 * ### Calling it from a Worker
 * **Example:** GetCatalogDataQualitySummary
 * ```typescript
 * const shop = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "shop" });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const getCatalogDataQualitySummary = yield* StarburstGalaxy.DataQuality.GetCatalogDataQualitySummary(shop);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const summary = yield* getCatalogDataQualitySummary();
 *         return yield* HttpServerResponse.json(summary.severityCounts);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(StarburstGalaxy.DataQuality.GetCatalogDataQualitySummaryHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product DataQuality
 */
export interface GetCatalogDataQualitySummary extends Binding.Service<
  GetCatalogDataQualitySummary,
  "StarburstGalaxy.DataQuality.GetCatalogDataQualitySummary",
  (
    catalog: AnyCatalog,
  ) => Effect.Effect<
    () => Effect.Effect<
      dataQualityMetrics.DataQualityCatalogSummary,
      dataQualityMetrics.GetCatalogDataQualitySummaryError,
      RuntimeContext
    >
  >
> {}

export const GetCatalogDataQualitySummary = Binding.Service<GetCatalogDataQualitySummary>(
  "StarburstGalaxy.DataQuality.GetCatalogDataQualitySummary",
);
