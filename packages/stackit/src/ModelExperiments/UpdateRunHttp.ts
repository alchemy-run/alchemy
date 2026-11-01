import * as mlflow from "@distilled.cloud/stackit/model_experiments_mlflow";
import * as Layer from "effect/Layer";
import { makeMlflowBinding } from "./BindingHttp.ts";
import { UpdateRun } from "./UpdateRun.ts";

/**
 * HTTP implementation of {@link UpdateRun}.
 *
 * @layer
 * @provides Stackit.ModelExperiments.UpdateRun
 */
export const UpdateRunHttp = Layer.succeed(UpdateRun, makeMlflowBinding(mlflow.updateRun));
