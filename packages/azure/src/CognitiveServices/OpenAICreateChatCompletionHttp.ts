import * as inference from "@distilled.cloud/azure/cognitiveservices-openai-inference";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAICreateChatCompletion } from "./OpenAICreateChatCompletion.ts";

/**
 * Implementation of {@link OpenAICreateChatCompletion} over the distilled
 * `cognitiveservices-openai-inference` data plane. Assigns the custom
 * `AzureOpenAIChatCompletionRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAICreateChatCompletion
 */
export const OpenAICreateChatCompletionHttp = Layer.effect(
  OpenAICreateChatCompletion,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAICreateChatCompletion",
    operation: inference.CreateChatCompletion,
    endpoint: "host",
    grants: [OpenAIRole.ChatCompletion],
  }),
);
