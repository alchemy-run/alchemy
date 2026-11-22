import * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAIListModels } from "./OpenAIListModels.ts";

/**
 * Implementation of {@link OpenAIListModels} over the distilled
 * `cognitiveservices-openai-authoring` data plane. Assigns the custom
 * `AzureOpenAIModelReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAIListModels
 */
export const OpenAIListModelsHttp = Layer.effect(
  OpenAIListModels,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAIListModels",
    operation: authoring.ListModels,
    endpoint: "url",
    grants: [OpenAIRole.ModelRead],
  }),
);
