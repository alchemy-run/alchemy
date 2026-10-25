import * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAIGetFineTuningCheckpoints } from "./OpenAIGetFineTuningCheckpoints.ts";

/**
 * Implementation of {@link OpenAIGetFineTuningCheckpoints} over the distilled
 * `cognitiveservices-openai-authoring` data plane. Assigns the custom
 * `AzureOpenAIFineTuningReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAIGetFineTuningCheckpoints
 */
export const OpenAIGetFineTuningCheckpointsHttp = Layer.effect(
  OpenAIGetFineTuningCheckpoints,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAIGetFineTuningCheckpoints",
    operation: authoring.GetFineTuningCheckpoints,
    endpoint: "url",
    grants: [OpenAIRole.FineTuningRead],
  }),
);
