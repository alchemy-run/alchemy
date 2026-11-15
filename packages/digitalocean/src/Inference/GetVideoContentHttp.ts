import * as DO from "@distilled.cloud/digitalocean";
import * as Layer from "effect/Layer";
import { GetVideoContent } from "./GetVideoContent.ts";
import { makeInferenceBinding } from "./InferenceBinding.ts";

/**
 * `GetVideoContent` over Serverless Inference (`https://inference.do-ai.run`).
 *
 * @layer
 * @product Serverless Inference
 * @provides DigitalOcean.Inference.GetVideoContent
 */
export const GetVideoContentHttp = Layer.succeed(
  GetVideoContent,
  makeInferenceBinding("DigitalOcean.Inference.GetVideoContent", DO.getInferenceVideoContent),
);
