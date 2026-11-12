import * as dataQuality from "@distilled.cloud/starburst-galaxy/data_quality";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { bindStarburstGalaxy } from "../StarburstGalaxyBindings.ts";
import type { DataQualityCheck } from "./DataQualityCheck.ts";
import { GetLatestDataQualityCheckEvaluation } from "./GetLatestDataQualityCheckEvaluation.ts";

/**
 * {@link GetLatestDataQualityCheckEvaluation} over the Galaxy API; works on any host.
 *
 * @layer
 * @product DataQuality
 * @provides StarburstGalaxy.DataQuality.GetLatestDataQualityCheckEvaluation
 */
export const GetLatestDataQualityCheckEvaluationHttp = Layer.succeed(
  GetLatestDataQualityCheckEvaluation,
  Effect.fn("StarburstGalaxy.DataQuality.GetLatestDataQualityCheckEvaluation")(function* (
    check: DataQualityCheck,
  ) {
    const galaxy = yield* bindStarburstGalaxy;
    const dataQualityCheckIdOf = yield* check.dataQualityCheckId;
    return () =>
      galaxy.authorize(
        Effect.gen(function* () {
          const dataQualityCheckId = yield* dataQualityCheckIdOf;
          return yield* dataQuality.getLatestDataQualityCheckEvaluation({ dataQualityCheckId });
        }),
      );
  }),
);
