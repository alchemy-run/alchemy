import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { UpdatePersonGroupPersonFace } from "./UpdatePersonGroupPersonFace.ts";

/**
 * Implementation of {@link UpdatePersonGroupPersonFace} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIPersonGroupFacesWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.UpdatePersonGroupPersonFace
 */
export const UpdatePersonGroupPersonFaceHttp = Layer.effect(
  UpdatePersonGroupPersonFace,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.UpdatePersonGroupPersonFace",
    operation: face.UpdatePersonGroupOperationPersonGroupPersonFace,
    grant: AIRole.PersonGroupFacesWrite,
  }),
);
