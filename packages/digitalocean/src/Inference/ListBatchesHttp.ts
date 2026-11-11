import * as DO from "@distilled.cloud/digitalocean";
import * as Layer from "effect/Layer";
import { makeInferenceBinding } from "./InferenceBinding.ts";
import { ListBatches } from "./ListBatches.ts";

/**
 * `ListBatches` over Serverless Inference (`https://inference.do-ai.run`).
 *
 * @layer
 * @product Serverless Inference
 * @provides DigitalOcean.Inference.ListBatches
 */
export const ListBatchesHttp = Layer.succeed(
  ListBatches,
  makeInferenceBinding("DigitalOcean.Inference.ListBatches", DO.listInferenceBatches),
);
