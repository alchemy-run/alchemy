import * as inference from "@distilled.cloud/azure/cognitiveservices-openai-inference";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAICreateEmbedding } from "./OpenAICreateEmbedding.ts";

/**
 * Implementation of {@link OpenAICreateEmbedding} over the distilled
 * `cognitiveservices-openai-inference` data plane. Assigns the custom
 * `AzureOpenAIEmbeddingRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAICreateEmbedding
 */
export const OpenAICreateEmbeddingHttp = Layer.effect(
  OpenAICreateEmbedding,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAICreateEmbedding",
    operation: inference.CreateEmbedding,
    endpoint: "host",
    grants: [OpenAIRole.Embedding],
  }),
);
