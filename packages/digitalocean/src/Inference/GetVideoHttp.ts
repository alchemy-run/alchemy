import * as DO from "@distilled.cloud/digitalocean";
import * as Layer from "effect/Layer";
import { GetVideo } from "./GetVideo.ts";
import { makeInferenceBinding } from "./InferenceBinding.ts";

/**
 * `GetVideo` over Serverless Inference (`https://inference.do-ai.run`).
 *
 * @layer
 * @product Serverless Inference
 * @provides DigitalOcean.Inference.GetVideo
 */
export const GetVideoHttp = Layer.succeed(
  GetVideo,
  makeInferenceBinding("DigitalOcean.Inference.GetVideo", DO.getInferenceVideo),
);
