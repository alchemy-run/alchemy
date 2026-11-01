import * as mlflow from "@distilled.cloud/stackit/model_experiments_mlflow";
import * as Layer from "effect/Layer";
import { makeMlflowBinding } from "./BindingHttp.ts";
import { LogParam } from "./LogParam.ts";

/**
 * HTTP implementation of {@link LogParam}.
 *
 * @layer
 * @provides Stackit.ModelExperiments.LogParam
 */
export const LogParamHttp = Layer.succeed(LogParam, makeMlflowBinding(mlflow.logParam));
