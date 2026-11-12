import * as dataQuality from "@distilled.cloud/starburst-galaxy/data_quality";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { bindStarburstGalaxy } from "../StarburstGalaxyBindings.ts";
import type { DataQualityCheck } from "./DataQualityCheck.ts";
import {
  EvaluateDataQualityCheck,
  type EvaluateDataQualityCheckRequest,
} from "./EvaluateDataQualityCheck.ts";

/**
 * {@link EvaluateDataQualityCheck} over the Galaxy API; works on any host.
 *
 * @layer
 * @product DataQuality
 * @provides StarburstGalaxy.DataQuality.EvaluateDataQualityCheck
 */
export const EvaluateDataQualityCheckHttp = Layer.succeed(
  EvaluateDataQualityCheck,
  Effect.fn("StarburstGalaxy.DataQuality.EvaluateDataQualityCheck")(function* (
    check: DataQualityCheck,
  ) {
    const galaxy = yield* bindStarburstGalaxy;
    const dataQualityCheckIdOf = yield* check.dataQualityCheckId;
    const clusterIdOf = yield* check.clusterId;
    return (request?: EvaluateDataQualityCheckRequest) =>
      galaxy.authorize(
        Effect.gen(function* () {
          const dataQualityCheckId = yield* dataQualityCheckIdOf;
          yield* dataQuality.evaluateDataQualityCheck({
            dataQualityCheckId,
            body: { dataQualityCheckId, clusterId: request?.clusterId ?? (yield* clusterIdOf) },
          });
        }),
      );
  }),
);
