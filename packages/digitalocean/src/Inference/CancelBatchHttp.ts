import * as DO from "@distilled.cloud/digitalocean";
import * as Layer from "effect/Layer";
import { CancelBatch } from "./CancelBatch.ts";
import { makeInferenceBinding } from "./InferenceBinding.ts";

/**
 * `CancelBatch` over Serverless Inference (`https://inference.do-ai.run`).
 *
 * @layer
 * @product Serverless Inference
 * @provides DigitalOcean.Inference.CancelBatch
 */
export const CancelBatchHttp = Layer.succeed(
  CancelBatch,
  makeInferenceBinding("DigitalOcean.Inference.CancelBatch", DO.cancelInferenceBatch),
);
