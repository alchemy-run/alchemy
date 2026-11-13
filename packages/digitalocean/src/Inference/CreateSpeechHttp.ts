import * as DO from "@distilled.cloud/digitalocean";
import * as Layer from "effect/Layer";
import { CreateSpeech } from "./CreateSpeech.ts";
import { makeInferenceBinding } from "./InferenceBinding.ts";

/**
 * `CreateSpeech` over Serverless Inference (`https://inference.do-ai.run`).
 *
 * @layer
 * @product Serverless Inference
 * @provides DigitalOcean.Inference.CreateSpeech
 */
export const CreateSpeechHttp = Layer.succeed(
  CreateSpeech,
  makeInferenceBinding("DigitalOcean.Inference.CreateSpeech", DO.createInferenceSpeech),
);
