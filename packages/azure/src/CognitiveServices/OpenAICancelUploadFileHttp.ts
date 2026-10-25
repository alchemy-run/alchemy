import * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAICancelUploadFile } from "./OpenAICancelUploadFile.ts";

/**
 * Implementation of {@link OpenAICancelUploadFile} over the distilled
 * `cognitiveservices-openai-authoring` data plane. Assigns the custom
 * `AzureOpenAIUploadWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAICancelUploadFile
 */
export const OpenAICancelUploadFileHttp = Layer.effect(
  OpenAICancelUploadFile,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAICancelUploadFile",
    operation: authoring.CancelUploadFile,
    endpoint: "url",
    grants: [OpenAIRole.UploadWrite],
  }),
);
