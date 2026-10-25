import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AddFaceListFace } from "./AddFaceListFace.ts";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";

/**
 * Implementation of {@link AddFaceListFace} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIFaceListFacesWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.AddFaceListFace
 */
export const AddFaceListFaceHttp = Layer.effect(
  AddFaceListFace,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.AddFaceListFace",
    operation: face.FaceListOperationsAddFaceListFace,
    grant: AIRole.FaceListFacesWrite,
  }),
);
