import * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Layer from "effect/Layer";
import { makeOpenAIHttpBinding, OpenAIRole } from "./OpenAIBindingHttp.ts";
import { OpenAIUploadFilePart } from "./OpenAIUploadFilePart.ts";

/**
 * Implementation of {@link OpenAIUploadFilePart} over the distilled
 * `cognitiveservices-openai-authoring` data plane. Assigns the custom
 * `AzureOpenAIUploadWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.OpenAIUploadFilePart
 */
export const OpenAIUploadFilePartHttp = Layer.effect(
  OpenAIUploadFilePart,
  makeOpenAIHttpBinding({
    tag: "Azure.CognitiveServices.OpenAIUploadFilePart",
    operation: authoring.UploadFilePart,
    endpoint: "url",
    grants: [OpenAIRole.UploadWrite],
  }),
);
