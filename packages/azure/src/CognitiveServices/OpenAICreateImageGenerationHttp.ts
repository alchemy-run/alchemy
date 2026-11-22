import * as inference from "@distilled.cloud/azure/cognitiveservices-openai-inference";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAICreateImageGeneration } from "./OpenAICreateImageGeneration.ts";

/**
 * Implementation of {@link OpenAICreateImageGeneration} over the distilled
 * `cognitiveservices-openai-inference` data plane. Assigns the custom
 * `AzureOpenAIImageGenerationRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAICreateImageGeneration
 */
export const OpenAICreateImageGenerationHttp = Layer.effect(
  OpenAICreateImageGeneration,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAICreateImageGeneration",
    operation: inference.CreateImageGeneration,
    endpoint: "host",
    grants: [OpenAIRole.ImageGeneration],
  }),
);
