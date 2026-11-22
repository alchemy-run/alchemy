import * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAICompleteUploadFile } from "./OpenAICompleteUploadFile.ts";

/**
 * Implementation of {@link OpenAICompleteUploadFile} over the distilled
 * `cognitiveservices-openai-authoring` data plane. Assigns the custom
 * `AzureOpenAIUploadWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAICompleteUploadFile
 */
export const OpenAICompleteUploadFileHttp = Layer.effect(
  OpenAICompleteUploadFile,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAICompleteUploadFile",
    operation: authoring.CompleteUploadFile,
    endpoint: "url",
    grants: [OpenAIRole.UploadWrite],
  }),
);
