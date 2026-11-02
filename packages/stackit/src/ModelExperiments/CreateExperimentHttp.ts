import * as mlflow from "@distilled.cloud/stackit/model_experiments_mlflow";
import * as Layer from "effect/Layer";
import { makeMlflowBinding } from "./BindingHttp.ts";
import { CreateExperiment } from "./CreateExperiment.ts";

/**
 * HTTP implementation of {@link CreateExperiment}.
 *
 * @layer
 * @provides Stackit.ModelExperiments.CreateExperiment
 */
export const CreateExperimentHttp = Layer.succeed(
  CreateExperiment,
  makeMlflowBinding(mlflow.createExperiment),
);
