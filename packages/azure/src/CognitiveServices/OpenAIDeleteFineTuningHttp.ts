import * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAIDeleteFineTuning } from "./OpenAIDeleteFineTuning.ts";

/**
 * Implementation of {@link OpenAIDeleteFineTuning} over the distilled
 * `cognitiveservices-openai-authoring` data plane. Assigns the custom
 * `AzureOpenAIFineTuningDeleteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAIDeleteFineTuning
 */
export const OpenAIDeleteFineTuningHttp = Layer.effect(
  OpenAIDeleteFineTuning,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAIDeleteFineTuning",
    operation: authoring.DeleteFineTuning,
    endpoint: "url",
    grants: [OpenAIRole.FineTuningDelete],
  }),
);
