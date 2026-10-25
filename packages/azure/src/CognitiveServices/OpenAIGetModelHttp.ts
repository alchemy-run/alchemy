import * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAIGetModel } from "./OpenAIGetModel.ts";

/**
 * Implementation of {@link OpenAIGetModel} over the distilled
 * `cognitiveservices-openai-authoring` data plane. Assigns the custom
 * `AzureOpenAIModelReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAIGetModel
 */
export const OpenAIGetModelHttp = Layer.effect(
  OpenAIGetModel,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAIGetModel",
    operation: authoring.GetModel,
    endpoint: "url",
    grants: [OpenAIRole.ModelRead],
  }),
);
