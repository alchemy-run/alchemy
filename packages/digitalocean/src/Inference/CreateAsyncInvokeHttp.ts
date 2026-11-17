import * as DO from "@distilled.cloud/digitalocean";
import * as Layer from "effect/Layer";
import { CreateAsyncInvoke } from "./CreateAsyncInvoke.ts";
import { makeInferenceBinding } from "./InferenceBinding.ts";

/**
 * `CreateAsyncInvoke` over Serverless Inference (`https://inference.do-ai.run`).
 *
 * @layer
 * @product Serverless Inference
 * @provides DigitalOcean.Inference.CreateAsyncInvoke
 */
export const CreateAsyncInvokeHttp = Layer.succeed(
  CreateAsyncInvoke,
  makeInferenceBinding("DigitalOcean.Inference.CreateAsyncInvoke", DO.inferenceCreateAsyncInvoke),
);
