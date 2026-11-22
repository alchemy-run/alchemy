import * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAIGetFileContent } from "./OpenAIGetFileContent.ts";

/**
 * Implementation of {@link OpenAIGetFileContent} over the distilled
 * `cognitiveservices-openai-authoring` data plane. Assigns the custom
 * `AzureOpenAIFileReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAIGetFileContent
 */
export const OpenAIGetFileContentHttp = Layer.effect(
  OpenAIGetFileContent,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAIGetFileContent",
    operation: authoring.GetFileContent,
    endpoint: "url",
    grants: [OpenAIRole.FileRead],
  }),
);
