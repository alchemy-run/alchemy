import * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAIGetFineTuning } from "./OpenAIGetFineTuning.ts";

/**
 * Implementation of {@link OpenAIGetFineTuning} over the distilled
 * `cognitiveservices-openai-authoring` data plane. Assigns the custom
 * `AzureOpenAIFineTuningReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAIGetFineTuning
 */
export const OpenAIGetFineTuningHttp = Layer.effect(
  OpenAIGetFineTuning,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAIGetFineTuning",
    operation: authoring.GetFineTuning,
    endpoint: "url",
    grants: [OpenAIRole.FineTuningRead],
  }),
);
