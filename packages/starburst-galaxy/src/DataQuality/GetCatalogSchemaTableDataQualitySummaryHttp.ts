import * as dataQualityMetrics from "@distilled.cloud/starburst-galaxy/data_quality_metrics";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";
import { bindStarburstGalaxy } from "../StarburstGalaxyBindings.ts";
import {
  GetCatalogSchemaTableDataQualitySummary,
  type GetCatalogSchemaTableDataQualitySummaryRequest,
} from "./GetCatalogSchemaTableDataQualitySummary.ts";

/**
 * {@link GetCatalogSchemaTableDataQualitySummary} over the Galaxy API; works on any host.
 *
 * @layer
 * @product DataQuality
 * @provides StarburstGalaxy.DataQuality.GetCatalogSchemaTableDataQualitySummary
 */
export const GetCatalogSchemaTableDataQualitySummaryHttp = Layer.succeed(
  GetCatalogSchemaTableDataQualitySummary,
  Effect.fn("StarburstGalaxy.DataQuality.GetCatalogSchemaTableDataQualitySummary")(function* (
    catalog: AnyCatalog,
  ) {
    const galaxy = yield* bindStarburstGalaxy;
    const catalogIdOf = yield* catalog.catalogId;
    return (request: GetCatalogSchemaTableDataQualitySummaryRequest) =>
      galaxy.authorize(
        Effect.gen(function* () {
          const catalogId = yield* catalogIdOf;
          return yield* dataQualityMetrics.getCatalogSchemaTableDataQualitySummary({
            catalogId,
            schemaId: request.schemaName,
            tableId: request.tableName,
          });
        }),
      );
  }),
);
