import * as inference from "@distilled.cloud/azure/cognitiveservices-openai-inference";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAICreateTranscription } from "./OpenAICreateTranscription.ts";

/**
 * Implementation of {@link OpenAICreateTranscription} over the distilled
 * `cognitiveservices-openai-inference` data plane. Assigns the custom
 * `AzureOpenAIAudioRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAICreateTranscription
 */
export const OpenAICreateTranscriptionHttp = Layer.effect(
  OpenAICreateTranscription,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAICreateTranscription",
    operation: inference.CreateTranscription,
    endpoint: "host",
    grants: [OpenAIRole.Audio],
  }),
);
