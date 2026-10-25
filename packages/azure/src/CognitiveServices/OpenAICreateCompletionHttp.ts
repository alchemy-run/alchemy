import * as inference from "@distilled.cloud/azure/cognitiveservices-openai-inference";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAICreateCompletion } from "./OpenAICreateCompletion.ts";

/**
 * Implementation of {@link OpenAICreateCompletion} over the distilled
 * `cognitiveservices-openai-inference` data plane. Assigns the custom
 * `AzureOpenAICompletionRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAICreateCompletion
 */
export const OpenAICreateCompletionHttp = Layer.effect(
  OpenAICreateCompletion,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAICreateCompletion",
    operation: inference.CreateCompletion,
    endpoint: "host",
    grants: [OpenAIRole.Completion],
  }),
);
