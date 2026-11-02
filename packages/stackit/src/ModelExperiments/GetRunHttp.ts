import * as mlflow from "@distilled.cloud/stackit/model_experiments_mlflow";
import * as Layer from "effect/Layer";
import { makeMlflowBinding } from "./BindingHttp.ts";
import { GetRun } from "./GetRun.ts";

/**
 * HTTP implementation of {@link GetRun}.
 *
 * @layer
 * @provides Stackit.ModelExperiments.GetRun
 */
export const GetRunHttp = Layer.succeed(GetRun, makeMlflowBinding(mlflow.getRun));
