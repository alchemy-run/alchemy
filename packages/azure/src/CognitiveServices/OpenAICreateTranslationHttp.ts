import * as inference from "@distilled.cloud/azure/cognitiveservices-openai-inference";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAICreateTranslation } from "./OpenAICreateTranslation.ts";

/**
 * Implementation of {@link OpenAICreateTranslation} over the distilled
 * `cognitiveservices-openai-inference` data plane. Assigns the custom
 * `AzureOpenAIAudioRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAICreateTranslation
 */
export const OpenAICreateTranslationHttp = Layer.effect(
  OpenAICreateTranslation,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAICreateTranslation",
    operation: inference.CreateTranslation,
    endpoint: "host",
    grants: [OpenAIRole.Audio],
  }),
);
