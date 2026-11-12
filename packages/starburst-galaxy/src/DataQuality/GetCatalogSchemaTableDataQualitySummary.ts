import type * as dataQualityMetrics from "@distilled.cloud/starburst-galaxy/data_quality_metrics";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";

/** What `getCatalogSchemaTableDataQualitySummary` takes. */
export interface GetCatalogSchemaTableDataQualitySummaryRequest {
  /** Schema name. */
  readonly schemaName: string;
  /** Table name. */
  readonly tableName: string;
}

/**
 * Read the data quality summary of one table of the bound catalog.
 *
 * The host calls Galaxy as the deploying profile's API client: Galaxy
 * can't mint a key per host or trust a host's identity (see
 * `StarburstGalaxyBindings`), so the client's role bounds what the host
 * may do.
 *
 * ### Calling it from a Worker
 * **Example:** GetCatalogSchemaTableDataQualitySummary
 * ```typescript
 * const shop = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "shop" });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const getCatalogSchemaTableDataQualitySummary = yield* StarburstGalaxy.DataQuality.GetCatalogSchemaTableDataQualitySummary(shop);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const summary = yield* getCatalogSchemaTableDataQualitySummary({ schemaName: "sales", tableName: "orders" });
 *         return yield* HttpServerResponse.json(summary.severityCounts);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(StarburstGalaxy.DataQuality.GetCatalogSchemaTableDataQualitySummaryHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product DataQuality
 */
export interface GetCatalogSchemaTableDataQualitySummary extends Binding.Service<
  GetCatalogSchemaTableDataQualitySummary,
  "StarburstGalaxy.DataQuality.GetCatalogSchemaTableDataQualitySummary",
  (
    catalog: AnyCatalog,
  ) => Effect.Effect<
    (
      request: GetCatalogSchemaTableDataQualitySummaryRequest,
    ) => Effect.Effect<
      dataQualityMetrics.DataQualityTableSummary,
      dataQualityMetrics.GetCatalogSchemaTableDataQualitySummaryError,
      RuntimeContext
    >
  >
> {}

export const GetCatalogSchemaTableDataQualitySummary =
  Binding.Service<GetCatalogSchemaTableDataQualitySummary>(
    "StarburstGalaxy.DataQuality.GetCatalogSchemaTableDataQualitySummary",
  );
