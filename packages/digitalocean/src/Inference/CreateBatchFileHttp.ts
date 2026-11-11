import * as DO from "@distilled.cloud/digitalocean";
import * as Layer from "effect/Layer";
import { CreateBatchFile } from "./CreateBatchFile.ts";
import { makeInferenceBinding } from "./InferenceBinding.ts";

/**
 * `CreateBatchFile` over Serverless Inference (`https://inference.do-ai.run`).
 *
 * @layer
 * @product Serverless Inference
 * @provides DigitalOcean.Inference.CreateBatchFile
 */
export const CreateBatchFileHttp = Layer.succeed(
  CreateBatchFile,
  makeInferenceBinding("DigitalOcean.Inference.CreateBatchFile", DO.createInferenceBatchFile),
);
