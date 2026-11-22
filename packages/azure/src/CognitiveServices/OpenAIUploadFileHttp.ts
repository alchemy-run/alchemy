import * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAIUploadFile } from "./OpenAIUploadFile.ts";

/**
 * Implementation of {@link OpenAIUploadFile} over the distilled
 * `cognitiveservices-openai-authoring` data plane. Assigns the custom
 * `AzureOpenAIFileWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAIUploadFile
 */
export const OpenAIUploadFileHttp = Layer.effect(
  OpenAIUploadFile,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAIUploadFile",
    operation: authoring.UploadFile,
    endpoint: "url",
    grants: [OpenAIRole.FileWrite],
  }),
);
