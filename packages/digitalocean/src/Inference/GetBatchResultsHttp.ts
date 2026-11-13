import * as DO from "@distilled.cloud/digitalocean";
import * as Layer from "effect/Layer";
import { GetBatchResults } from "./GetBatchResults.ts";
import { makeInferenceBinding } from "./InferenceBinding.ts";

/**
 * `GetBatchResults` over Serverless Inference (`https://inference.do-ai.run`).
 *
 * @layer
 * @product Serverless Inference
 * @provides DigitalOcean.Inference.GetBatchResults
 */
export const GetBatchResultsHttp = Layer.succeed(
  GetBatchResults,
  makeInferenceBinding("DigitalOcean.Inference.GetBatchResults", DO.getInferenceBatchResults),
);
