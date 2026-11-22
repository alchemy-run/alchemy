import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AddLargeFaceListFaceFromUrl } from "./AddLargeFaceListFaceFromUrl.ts";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";

/**
 * Implementation of {@link AddLargeFaceListFaceFromUrl} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargeFaceListFacesWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.AddLargeFaceListFaceFromUrl
 */
export const AddLargeFaceListFaceFromUrlHttp = Layer.effect(
  AddLargeFaceListFaceFromUrl,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.AddLargeFaceListFaceFromUrl",
    operation: face.FaceListOperationsAddLargeFaceListFaceFromUrl,
    grant: AIRole.LargeFaceListFacesWrite,
  }),
);
