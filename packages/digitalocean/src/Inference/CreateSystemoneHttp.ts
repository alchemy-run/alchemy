import * as DO from "@distilled.cloud/digitalocean";
import * as Layer from "effect/Layer";
import { CreateSystemone } from "./CreateSystemone.ts";
import { makeInferenceBinding } from "./InferenceBinding.ts";

/**
 * `CreateSystemone` over Serverless Inference (`https://inference.do-ai.run`).
 *
 * @layer
 * @product Serverless Inference
 * @provides DigitalOcean.Inference.CreateSystemone
 */
export const CreateSystemoneHttp = Layer.succeed(
  CreateSystemone,
  makeInferenceBinding("DigitalOcean.Inference.CreateSystemone", DO.createInferenceSystemone),
);
