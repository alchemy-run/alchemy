import * as mlflow from "@distilled.cloud/stackit/model_experiments_mlflow";
import * as Layer from "effect/Layer";
import { makeMlflowBinding } from "./BindingHttp.ts";
import { GetExperiment } from "./GetExperiment.ts";

/**
 * HTTP implementation of {@link GetExperiment}.
 *
 * @layer
 * @provides Stackit.ModelExperiments.GetExperiment
 */
export const GetExperimentHttp = Layer.succeed(
  GetExperiment,
  makeMlflowBinding(mlflow.getExperiment),
);
