import * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAIGetBatch } from "./OpenAIGetBatch.ts";

/**
 * Implementation of {@link OpenAIGetBatch} over the distilled
 * `cognitiveservices-openai-authoring` data plane. Assigns the custom
 * `AzureOpenAIBatchReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAIGetBatch
 */
export const OpenAIGetBatchHttp = Layer.effect(
  OpenAIGetBatch,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAIGetBatch",
    operation: authoring.GetBatch,
    endpoint: "url",
    grants: [OpenAIRole.BatchRead],
  }),
);
