import * as modelServing from "@distilled.cloud/stackit/model_serving";
import * as Layer from "effect/Layer";
import { makeCatalogHttpBinding } from "./BindingHttp.ts";
import { GetEmbeddingModel } from "./GetEmbeddingModel.ts";

/**
 * HTTP implementation of {@link GetEmbeddingModel}.
 *
 * @layer
 * @provides Stackit.ModelServing.GetEmbeddingModel
 */
export const GetEmbeddingModelHttp = Layer.effect(
  GetEmbeddingModel,
  makeCatalogHttpBinding({
    tag: "Stackit.ModelServing.GetEmbeddingModel",
    operation: modelServing.getEmbeddingModel,
  }),
);
