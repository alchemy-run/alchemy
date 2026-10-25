import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AddFaceListFaceFromUrl } from "./AddFaceListFaceFromUrl.ts";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";

/**
 * Implementation of {@link AddFaceListFaceFromUrl} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIFaceListFacesWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.AddFaceListFaceFromUrl
 */
export const AddFaceListFaceFromUrlHttp = Layer.effect(
  AddFaceListFaceFromUrl,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.AddFaceListFaceFromUrl",
    operation: face.FaceListOperationsAddFaceListFaceFromUrl,
    grant: AIRole.FaceListFacesWrite,
  }),
);
