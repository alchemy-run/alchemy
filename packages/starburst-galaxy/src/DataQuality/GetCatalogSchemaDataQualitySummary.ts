import type * as dataQualityMetrics from "@distilled.cloud/starburst-galaxy/data_quality_metrics";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";

/** What `getCatalogSchemaDataQualitySummary` takes. */
export interface GetCatalogSchemaDataQualitySummaryRequest {
  /** Schema name. */
  readonly schemaName: string;
}

/**
 * Read the data quality summary of one schema of the bound catalog.
 *
 * The host calls Galaxy as the deploying profile's API client: Galaxy
 * can't mint a key per host or trust a host's identity (see
 * `StarburstGalaxyBindings`), so the client's role bounds what the host
 * may do.
 *
 * ### Calling it from a Worker
 * **Example:** GetCatalogSchemaDataQualitySummary
 * ```typescript
 * const shop = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "shop" });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const getCatalogSchemaDataQualitySummary = yield* StarburstGalaxy.DataQuality.GetCatalogSchemaDataQualitySummary(shop);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const summary = yield* getCatalogSchemaDataQualitySummary({ schemaName: "sales" });
 *         return yield* HttpServerResponse.json(summary.severityCounts);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(StarburstGalaxy.DataQuality.GetCatalogSchemaDataQualitySummaryHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product DataQuality
 */
export interface GetCatalogSchemaDataQualitySummary extends Binding.Service<
  GetCatalogSchemaDataQualitySummary,
  "StarburstGalaxy.DataQuality.GetCatalogSchemaDataQualitySummary",
  (
    catalog: AnyCatalog,
  ) => Effect.Effect<
    (
      request: GetCatalogSchemaDataQualitySummaryRequest,
    ) => Effect.Effect<
      dataQualityMetrics.DataQualitySchemaSummary,
      dataQualityMetrics.GetCatalogSchemaDataQualitySummaryError,
      RuntimeContext
    >
  >
> {}

export const GetCatalogSchemaDataQualitySummary =
  Binding.Service<GetCatalogSchemaDataQualitySummary>(
    "StarburstGalaxy.DataQuality.GetCatalogSchemaDataQualitySummary",
  );
