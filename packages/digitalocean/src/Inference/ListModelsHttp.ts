import * as DO from "@distilled.cloud/digitalocean";
import * as Layer from "effect/Layer";
import { makeInferenceBinding } from "./InferenceBinding.ts";
import { ListModels } from "./ListModels.ts";

/**
 * `ListModels` over Serverless Inference (`https://inference.do-ai.run`).
 *
 * @layer
 * @product Serverless Inference
 * @provides DigitalOcean.Inference.ListModels
 */
export const ListModelsHttp = Layer.succeed(
  ListModels,
  makeInferenceBinding("DigitalOcean.Inference.ListModels", DO.listInferenceModels),
);
