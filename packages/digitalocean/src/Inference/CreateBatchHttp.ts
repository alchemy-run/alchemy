import * as DO from "@distilled.cloud/digitalocean";
import * as Layer from "effect/Layer";
import { CreateBatch } from "./CreateBatch.ts";
import { makeInferenceBinding } from "./InferenceBinding.ts";

/**
 * `CreateBatch` over Serverless Inference (`https://inference.do-ai.run`).
 *
 * @layer
 * @product Serverless Inference
 * @provides DigitalOcean.Inference.CreateBatch
 */
export const CreateBatchHttp = Layer.succeed(
  CreateBatch,
  makeInferenceBinding("DigitalOcean.Inference.CreateBatch", DO.createInferenceBatch),
);
