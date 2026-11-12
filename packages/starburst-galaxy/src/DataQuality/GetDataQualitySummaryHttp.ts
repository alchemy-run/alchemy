import * as dataQualityMetrics from "@distilled.cloud/starburst-galaxy/data_quality_metrics";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { bindStarburstGalaxy } from "../StarburstGalaxyBindings.ts";
import { GetDataQualitySummary } from "./GetDataQualitySummary.ts";

/**
 * {@link GetDataQualitySummary} over the Galaxy API; works on any host.
 *
 * @layer
 * @product DataQuality
 * @provides StarburstGalaxy.DataQuality.GetDataQualitySummary
 */
export const GetDataQualitySummaryHttp = Layer.succeed(
  GetDataQualitySummary,
  Effect.fn("StarburstGalaxy.DataQuality.GetDataQualitySummary")(function* () {
    const galaxy = yield* bindStarburstGalaxy;
    return () => galaxy.authorize(dataQualityMetrics.getDataQualitySummary({}));
  }),
);
