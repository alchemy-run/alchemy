import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AddLargePersonGroupPersonFaceFromUrl } from "./AddLargePersonGroupPersonFaceFromUrl.ts";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";

/**
 * Implementation of {@link AddLargePersonGroupPersonFaceFromUrl} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargePersonGroupFacesWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.AddLargePersonGroupPersonFaceFromUrl
 */
export const AddLargePersonGroupPersonFaceFromUrlHttp = Layer.effect(
  AddLargePersonGroupPersonFaceFromUrl,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.AddLargePersonGroupPersonFaceFromUrl",
    operation: face.AddPersonGroupOperationLargePersonGroupPersonFaceFromUrl,
    grant: AIRole.LargePersonGroupFacesWrite,
  }),
);
