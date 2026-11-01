import * as modelServing from "@distilled.cloud/stackit/model_serving";
import * as Layer from "effect/Layer";
import { makeCatalogHttpBinding } from "./BindingHttp.ts";
import { ListModels } from "./ListModels.ts";

/**
 * HTTP implementation of {@link ListModels}.
 *
 * @layer
 * @provides Stackit.ModelServing.ListModels
 */
export const ListModelsHttp = Layer.effect(
  ListModels,
  makeCatalogHttpBinding({
    tag: "Stackit.ModelServing.ListModels",
    operation: modelServing.listModels,
  }),
);
