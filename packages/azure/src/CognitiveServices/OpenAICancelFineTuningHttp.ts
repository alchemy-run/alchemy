import * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAICancelFineTuning } from "./OpenAICancelFineTuning.ts";

/**
 * Implementation of {@link OpenAICancelFineTuning} over the distilled
 * `cognitiveservices-openai-authoring` data plane. Assigns the custom
 * `AzureOpenAIFineTuningWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAICancelFineTuning
 */
export const OpenAICancelFineTuningHttp = Layer.effect(
  OpenAICancelFineTuning,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAICancelFineTuning",
    operation: authoring.CancelFineTuning,
    endpoint: "url",
    grants: [OpenAIRole.FineTuningWrite],
  }),
);
