import * as DO from "@distilled.cloud/digitalocean";
import * as Layer from "effect/Layer";
import { CreateVideo } from "./CreateVideo.ts";
import { makeInferenceBinding } from "./InferenceBinding.ts";

/**
 * `CreateVideo` over Serverless Inference (`https://inference.do-ai.run`).
 *
 * @layer
 * @product Serverless Inference
 * @provides DigitalOcean.Inference.CreateVideo
 */
export const CreateVideoHttp = Layer.succeed(
  CreateVideo,
  makeInferenceBinding("DigitalOcean.Inference.CreateVideo", DO.createInferenceVideo),
);
