import * as DO from "@distilled.cloud/digitalocean";
import * as Layer from "effect/Layer";
import { CreateChatCompletion } from "./CreateChatCompletion.ts";
import { makeInferenceBinding } from "./InferenceBinding.ts";

/**
 * `CreateChatCompletion` over Serverless Inference (`https://inference.do-ai.run`).
 *
 * @layer
 * @product Serverless Inference
 * @provides DigitalOcean.Inference.CreateChatCompletion
 */
export const CreateChatCompletionHttp = Layer.succeed(
  CreateChatCompletion,
  makeInferenceBinding(
    "DigitalOcean.Inference.CreateChatCompletion",
    DO.createInferenceChatCompletion,
  ),
);
