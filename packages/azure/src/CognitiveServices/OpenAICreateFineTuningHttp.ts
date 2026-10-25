import * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAICreateFineTuning } from "./OpenAICreateFineTuning.ts";

/**
 * Implementation of {@link OpenAICreateFineTuning} over the distilled
 * `cognitiveservices-openai-authoring` data plane. Assigns the custom
 * `AzureOpenAIFineTuningWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAICreateFineTuning
 */
export const OpenAICreateFineTuningHttp = Layer.effect(
  OpenAICreateFineTuning,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAICreateFineTuning",
    operation: authoring.CreateFineTuning,
    endpoint: "url",
    grants: [OpenAIRole.FineTuningWrite],
  }),
);
