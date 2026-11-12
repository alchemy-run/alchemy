import * as dataQualityMetrics from "@distilled.cloud/starburst-galaxy/data_quality_metrics";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";
import { bindStarburstGalaxy } from "../StarburstGalaxyBindings.ts";
import {
  GetCatalogSchemaDataQualitySummary,
  type GetCatalogSchemaDataQualitySummaryRequest,
} from "./GetCatalogSchemaDataQualitySummary.ts";

/**
 * {@link GetCatalogSchemaDataQualitySummary} over the Galaxy API; works on any host.
 *
 * @layer
 * @product DataQuality
 * @provides StarburstGalaxy.DataQuality.GetCatalogSchemaDataQualitySummary
 */
export const GetCatalogSchemaDataQualitySummaryHttp = Layer.succeed(
  GetCatalogSchemaDataQualitySummary,
  Effect.fn("StarburstGalaxy.DataQuality.GetCatalogSchemaDataQualitySummary")(function* (
    catalog: AnyCatalog,
  ) {
    const galaxy = yield* bindStarburstGalaxy;
    const catalogIdOf = yield* catalog.catalogId;
    return (request: GetCatalogSchemaDataQualitySummaryRequest) =>
      galaxy.authorize(
        Effect.gen(function* () {
          const catalogId = yield* catalogIdOf;
          return yield* dataQualityMetrics.getCatalogSchemaDataQualitySummary({
            catalogId,
            schemaId: request.schemaName,
          });
        }),
      );
  }),
);
