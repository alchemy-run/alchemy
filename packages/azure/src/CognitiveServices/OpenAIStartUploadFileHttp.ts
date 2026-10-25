import * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAIStartUploadFile } from "./OpenAIStartUploadFile.ts";

/**
 * Implementation of {@link OpenAIStartUploadFile} over the distilled
 * `cognitiveservices-openai-authoring` data plane. Assigns the custom
 * `AzureOpenAIUploadWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAIStartUploadFile
 */
export const OpenAIStartUploadFileHttp = Layer.effect(
  OpenAIStartUploadFile,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAIStartUploadFile",
    operation: authoring.StartUploadFile,
    endpoint: "url",
    grants: [OpenAIRole.UploadWrite],
  }),
);
