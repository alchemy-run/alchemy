import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { DeleteLargeFaceListFace } from "./DeleteLargeFaceListFace.ts";

/**
 * Implementation of {@link DeleteLargeFaceListFace} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargeFaceListFacesDeleteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeleteLargeFaceListFace
 */
export const DeleteLargeFaceListFaceHttp = Layer.effect(
  DeleteLargeFaceListFace,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.DeleteLargeFaceListFace",
    operation: face.FaceListOperationsDeleteLargeFaceListFace,
    grant: AIRole.LargeFaceListFacesDelete,
  }),
);
