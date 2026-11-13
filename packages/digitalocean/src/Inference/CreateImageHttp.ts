import * as DO from "@distilled.cloud/digitalocean";
import * as Layer from "effect/Layer";
import { CreateImage } from "./CreateImage.ts";
import { makeInferenceBinding } from "./InferenceBinding.ts";

/**
 * `CreateImage` over Serverless Inference (`https://inference.do-ai.run`).
 *
 * @layer
 * @product Serverless Inference
 * @provides DigitalOcean.Inference.CreateImage
 */
export const CreateImageHttp = Layer.succeed(
  CreateImage,
  makeInferenceBinding("DigitalOcean.Inference.CreateImage", DO.createInferenceImage),
);
