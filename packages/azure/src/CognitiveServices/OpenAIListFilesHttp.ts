import * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAIListFiles } from "./OpenAIListFiles.ts";

/**
 * Implementation of {@link OpenAIListFiles} over the distilled
 * `cognitiveservices-openai-authoring` data plane. Assigns the custom
 * `AzureOpenAIFileReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAIListFiles
 */
export const OpenAIListFilesHttp = Layer.effect(
  OpenAIListFiles,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAIListFiles",
    operation: authoring.ListFiles,
    endpoint: "url",
    grants: [OpenAIRole.FileRead],
  }),
);
