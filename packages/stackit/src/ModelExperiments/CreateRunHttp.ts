import * as mlflow from "@distilled.cloud/stackit/model_experiments_mlflow";
import * as Layer from "effect/Layer";
import { makeMlflowBinding } from "./BindingHttp.ts";
import { CreateRun } from "./CreateRun.ts";

/**
 * HTTP implementation of {@link CreateRun}.
 *
 * @layer
 * @provides Stackit.ModelExperiments.CreateRun
 */
export const CreateRunHttp = Layer.succeed(CreateRun, makeMlflowBinding(mlflow.createRun));
