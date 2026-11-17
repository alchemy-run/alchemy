import * as DO from "@distilled.cloud/digitalocean";
import * as Layer from "effect/Layer";
import { GetBatch } from "./GetBatch.ts";
import { makeInferenceBinding } from "./InferenceBinding.ts";

/**
 * `GetBatch` over Serverless Inference (`https://inference.do-ai.run`).
 *
 * @layer
 * @product Serverless Inference
 * @provides DigitalOcean.Inference.GetBatch
 */
export const GetBatchHttp = Layer.succeed(
  GetBatch,
  makeInferenceBinding("DigitalOcean.Inference.GetBatch", DO.getInferenceBatch),
);
