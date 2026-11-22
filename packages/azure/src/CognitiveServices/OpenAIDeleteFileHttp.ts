import * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAIDeleteFile } from "./OpenAIDeleteFile.ts";

/**
 * Implementation of {@link OpenAIDeleteFile} over the distilled
 * `cognitiveservices-openai-authoring` data plane. Assigns the custom
 * `AzureOpenAIFileDeleteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAIDeleteFile
 */
export const OpenAIDeleteFileHttp = Layer.effect(
  OpenAIDeleteFile,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAIDeleteFile",
    operation: authoring.DeleteFile,
    endpoint: "url",
    grants: [OpenAIRole.FileDelete],
  }),
);
