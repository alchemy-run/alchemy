import * as mlflow from "@distilled.cloud/stackit/model_experiments_mlflow";
import * as Layer from "effect/Layer";
import { makeMlflowBinding } from "./BindingHttp.ts";
import { LogMetric } from "./LogMetric.ts";

/**
 * HTTP implementation of {@link LogMetric}.
 *
 * @layer
 * @provides Stackit.ModelExperiments.LogMetric
 */
export const LogMetricHttp = Layer.succeed(LogMetric, makeMlflowBinding(mlflow.logMetric));
