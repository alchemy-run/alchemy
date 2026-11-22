import * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAICancelBatch } from "./OpenAICancelBatch.ts";

/**
 * Implementation of {@link OpenAICancelBatch} over the distilled
 * `cognitiveservices-openai-authoring` data plane. Assigns the custom
 * `AzureOpenAIBatchCancelRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAICancelBatch
 */
export const OpenAICancelBatchHttp = Layer.effect(
  OpenAICancelBatch,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAICancelBatch",
    operation: authoring.CancelBatch,
    endpoint: "url",
    grants: [OpenAIRole.BatchCancel],
  }),
);
