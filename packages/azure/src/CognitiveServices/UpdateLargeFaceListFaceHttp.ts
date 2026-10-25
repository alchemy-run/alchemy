import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { UpdateLargeFaceListFace } from "./UpdateLargeFaceListFace.ts";

/**
 * Implementation of {@link UpdateLargeFaceListFace} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargeFaceListFacesWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.UpdateLargeFaceListFace
 */
export const UpdateLargeFaceListFaceHttp = Layer.effect(
  UpdateLargeFaceListFace,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.UpdateLargeFaceListFace",
    operation: face.FaceListOperationsUpdateLargeFaceListFace,
    grant: AIRole.LargeFaceListFacesWrite,
  }),
);
