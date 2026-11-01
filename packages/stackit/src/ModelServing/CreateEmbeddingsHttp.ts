import * as inference from "@distilled.cloud/stackit/model_serving_inference";
import * as Layer from "effect/Layer";
import { makeInferenceBinding } from "./BindingHttp.ts";
import { CreateEmbeddings } from "./CreateEmbeddings.ts";

/**
 * HTTP implementation of {@link CreateEmbeddings}.
 *
 * @layer
 * @provides Stackit.ModelServing.CreateEmbeddings
 */
export const CreateEmbeddingsHttp = Layer.succeed(
  CreateEmbeddings,
  makeInferenceBinding(inference.createEmbeddings),
);
