import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AddLargeFaceListFace } from "./AddLargeFaceListFace.ts";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";

/**
 * Implementation of {@link AddLargeFaceListFace} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAILargeFaceListFacesWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.AddLargeFaceListFace
 */
export const AddLargeFaceListFaceHttp = Layer.effect(
  AddLargeFaceListFace,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.AddLargeFaceListFace",
    operation: face.FaceListOperationsAddLargeFaceListFace,
    grant: AIRole.LargeFaceListFacesWrite,
  }),
);
