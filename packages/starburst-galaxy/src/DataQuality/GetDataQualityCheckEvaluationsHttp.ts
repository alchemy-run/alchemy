import * as dataQuality from "@distilled.cloud/starburst-galaxy/data_quality";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { bindStarburstGalaxy } from "../StarburstGalaxyBindings.ts";
import type { DataQualityCheck } from "./DataQualityCheck.ts";
import { GetDataQualityCheckEvaluations } from "./GetDataQualityCheckEvaluations.ts";

/**
 * {@link GetDataQualityCheckEvaluations} over the Galaxy API; works on any host.
 *
 * @layer
 * @product DataQuality
 * @provides StarburstGalaxy.DataQuality.GetDataQualityCheckEvaluations
 */
export const GetDataQualityCheckEvaluationsHttp = Layer.succeed(
  GetDataQualityCheckEvaluations,
  Effect.fn("StarburstGalaxy.DataQuality.GetDataQualityCheckEvaluations")(function* (
    check: DataQualityCheck,
  ) {
    const galaxy = yield* bindStarburstGalaxy;
    const dataQualityCheckIdOf = yield* check.dataQualityCheckId;
    return () =>
      galaxy.authorize(
        Effect.gen(function* () {
          const dataQualityCheckId = yield* dataQualityCheckIdOf;
          return yield* dataQuality.getDataQualityCheckEvaluations({ dataQualityCheckId });
        }),
      );
  }),
);
