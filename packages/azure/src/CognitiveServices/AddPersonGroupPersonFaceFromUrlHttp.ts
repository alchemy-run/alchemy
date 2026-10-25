import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AddPersonGroupPersonFaceFromUrl } from "./AddPersonGroupPersonFaceFromUrl.ts";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";

/**
 * Implementation of {@link AddPersonGroupPersonFaceFromUrl} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIPersonGroupFacesWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.AddPersonGroupPersonFaceFromUrl
 */
export const AddPersonGroupPersonFaceFromUrlHttp = Layer.effect(
  AddPersonGroupPersonFaceFromUrl,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.AddPersonGroupPersonFaceFromUrl",
    operation: face.AddPersonGroupOperationPersonGroupPersonFaceFromUrl,
    grant: AIRole.PersonGroupFacesWrite,
  }),
);
