import * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAIListFineTuning } from "./OpenAIListFineTuning.ts";

/**
 * Implementation of {@link OpenAIListFineTuning} over the distilled
 * `cognitiveservices-openai-authoring` data plane. Assigns the custom
 * `AzureOpenAIFineTuningReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAIListFineTuning
 */
export const OpenAIListFineTuningHttp = Layer.effect(
  OpenAIListFineTuning,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAIListFineTuning",
    operation: authoring.ListFineTuning,
    endpoint: "url",
    grants: [OpenAIRole.FineTuningRead],
  }),
);
