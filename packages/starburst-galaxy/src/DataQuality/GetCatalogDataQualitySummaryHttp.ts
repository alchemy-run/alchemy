import * as dataQualityMetrics from "@distilled.cloud/starburst-galaxy/data_quality_metrics";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AnyCatalog } from "../Catalog/AnyCatalog.ts";
import { bindStarburstGalaxy } from "../StarburstGalaxyBindings.ts";
import { GetCatalogDataQualitySummary } from "./GetCatalogDataQualitySummary.ts";

/**
 * {@link GetCatalogDataQualitySummary} over the Galaxy API; works on any host.
 *
 * @layer
 * @product DataQuality
 * @provides StarburstGalaxy.DataQuality.GetCatalogDataQualitySummary
 */
export const GetCatalogDataQualitySummaryHttp = Layer.succeed(
  GetCatalogDataQualitySummary,
  Effect.fn("StarburstGalaxy.DataQuality.GetCatalogDataQualitySummary")(function* (
    catalog: AnyCatalog,
  ) {
    const galaxy = yield* bindStarburstGalaxy;
    const catalogIdOf = yield* catalog.catalogId;
    return () =>
      galaxy.authorize(
        Effect.gen(function* () {
          const catalogId = yield* catalogIdOf;
          return yield* dataQualityMetrics.getCatalogDataQualitySummary({ catalogId });
        }),
      );
  }),
);
