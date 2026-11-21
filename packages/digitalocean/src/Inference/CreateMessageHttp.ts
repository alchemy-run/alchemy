import * as DO from "@distilled.cloud/digitalocean";
import * as Layer from "effect/Layer";
import { CreateMessage } from "./CreateMessage.ts";
import { makeInferenceBinding } from "./InferenceBinding.ts";

/**
 * `CreateMessage` over Serverless Inference (`https://inference.do-ai.run`).
 *
 * @layer
 * @product Serverless Inference
 * @provides DigitalOcean.Inference.CreateMessage
 */
export const CreateMessageHttp = Layer.succeed(
  CreateMessage,
  makeInferenceBinding("DigitalOcean.Inference.CreateMessage", DO.createInferenceMessages),
);
