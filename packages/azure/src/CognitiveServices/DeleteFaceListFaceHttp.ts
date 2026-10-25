import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { DeleteFaceListFace } from "./DeleteFaceListFace.ts";

/**
 * Implementation of {@link DeleteFaceListFace} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIFaceListFacesDeleteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeleteFaceListFace
 */
export const DeleteFaceListFaceHttp = Layer.effect(
  DeleteFaceListFace,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.DeleteFaceListFace",
    operation: face.FaceListOperationsDeleteFaceListFace,
    grant: AIRole.FaceListFacesDelete,
  }),
);
