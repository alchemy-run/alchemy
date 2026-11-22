import * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAIListBatch } from "./OpenAIListBatch.ts";

/**
 * Implementation of {@link OpenAIListBatch} over the distilled
 * `cognitiveservices-openai-authoring` data plane. Assigns the custom
 * `AzureOpenAIBatchReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAIListBatch
 */
export const OpenAIListBatchHttp = Layer.effect(
  OpenAIListBatch,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAIListBatch",
    operation: authoring.ListBatch,
    endpoint: "url",
    grants: [OpenAIRole.BatchRead],
  }),
);
