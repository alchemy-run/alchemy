import * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAIGetFile } from "./OpenAIGetFile.ts";

/**
 * Implementation of {@link OpenAIGetFile} over the distilled
 * `cognitiveservices-openai-authoring` data plane. Assigns the custom
 * `AzureOpenAIFileReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAIGetFile
 */
export const OpenAIGetFileHttp = Layer.effect(
  OpenAIGetFile,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAIGetFile",
    operation: authoring.GetFile,
    endpoint: "url",
    grants: [OpenAIRole.FileRead],
  }),
);
