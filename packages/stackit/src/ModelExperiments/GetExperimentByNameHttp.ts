import * as mlflow from "@distilled.cloud/stackit/model_experiments_mlflow";
import * as Layer from "effect/Layer";
import { makeMlflowBinding } from "./BindingHttp.ts";
import { GetExperimentByName } from "./GetExperimentByName.ts";

/**
 * HTTP implementation of {@link GetExperimentByName}.
 *
 * @layer
 * @provides Stackit.ModelExperiments.GetExperimentByName
 */
export const GetExperimentByNameHttp = Layer.succeed(
  GetExperimentByName,
  makeMlflowBinding(mlflow.getExperimentByName),
);
