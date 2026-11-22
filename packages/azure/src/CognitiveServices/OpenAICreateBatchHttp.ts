import * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAICreateBatch } from "./OpenAICreateBatch.ts";

/**
 * Implementation of {@link OpenAICreateBatch} over the distilled
 * `cognitiveservices-openai-authoring` data plane. Assigns the custom
 * `AzureOpenAIBatchCreateRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAICreateBatch
 */
export const OpenAICreateBatchHttp = Layer.effect(
  OpenAICreateBatch,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAICreateBatch",
    operation: authoring.CreateBatch,
    endpoint: "url",
    grants: [OpenAIRole.BatchCreate],
  }),
);
