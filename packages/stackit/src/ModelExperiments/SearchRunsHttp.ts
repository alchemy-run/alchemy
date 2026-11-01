import * as mlflow from "@distilled.cloud/stackit/model_experiments_mlflow";
import * as Layer from "effect/Layer";
import { makeMlflowBinding } from "./BindingHttp.ts";
import { SearchRuns } from "./SearchRuns.ts";

/**
 * HTTP implementation of {@link SearchRuns}.
 *
 * @layer
 * @provides Stackit.ModelExperiments.SearchRuns
 */
export const SearchRunsHttp = Layer.succeed(SearchRuns, makeMlflowBinding(mlflow.searchRuns));
