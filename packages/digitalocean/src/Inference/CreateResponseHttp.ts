import * as DO from "@distilled.cloud/digitalocean";
import * as Layer from "effect/Layer";
import { CreateResponse } from "./CreateResponse.ts";
import { makeInferenceBinding } from "./InferenceBinding.ts";

/**
 * `CreateResponse` over Serverless Inference (`https://inference.do-ai.run`).
 *
 * @layer
 * @product Serverless Inference
 * @provides DigitalOcean.Inference.CreateResponse
 */
export const CreateResponseHttp = Layer.succeed(
  CreateResponse,
  makeInferenceBinding("DigitalOcean.Inference.CreateResponse", DO.createInferenceResponse),
);
