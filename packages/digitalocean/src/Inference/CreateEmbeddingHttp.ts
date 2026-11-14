import * as DO from "@distilled.cloud/digitalocean";
import * as Layer from "effect/Layer";
import { CreateEmbedding } from "./CreateEmbedding.ts";
import { makeInferenceBinding } from "./InferenceBinding.ts";

/**
 * `CreateEmbedding` over Serverless Inference (`https://inference.do-ai.run`).
 *
 * @layer
 * @product Serverless Inference
 * @provides DigitalOcean.Inference.CreateEmbedding
 */
export const CreateEmbeddingHttp = Layer.succeed(
  CreateEmbedding,
  makeInferenceBinding("DigitalOcean.Inference.CreateEmbedding", DO.createInferenceEmbedding),
);
