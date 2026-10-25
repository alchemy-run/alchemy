import * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAIImportFile } from "./OpenAIImportFile.ts";

/**
 * Implementation of {@link OpenAIImportFile} over the distilled
 * `cognitiveservices-openai-authoring` data plane. Assigns the custom
 * `AzureOpenAIFileWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAIImportFile
 */
export const OpenAIImportFileHttp = Layer.effect(
  OpenAIImportFile,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAIImportFile",
    operation: authoring.ImportFile,
    endpoint: "url",
    grants: [OpenAIRole.FileWrite],
  }),
);
