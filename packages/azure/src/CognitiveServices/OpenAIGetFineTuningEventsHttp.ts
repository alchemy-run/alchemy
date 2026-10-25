import * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAIGetFineTuningEvents } from "./OpenAIGetFineTuningEvents.ts";

/**
 * Implementation of {@link OpenAIGetFineTuningEvents} over the distilled
 * `cognitiveservices-openai-authoring` data plane. Assigns the custom
 * `AzureOpenAIFineTuningReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAIGetFineTuningEvents
 */
export const OpenAIGetFineTuningEventsHttp = Layer.effect(
  OpenAIGetFineTuningEvents,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAIGetFineTuningEvents",
    operation: authoring.GetFineTuningEvents,
    endpoint: "url",
    grants: [OpenAIRole.FineTuningRead],
  }),
);
