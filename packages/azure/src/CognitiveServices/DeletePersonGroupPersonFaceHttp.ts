import * as face from "@distilled.cloud/azure/ai-face";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { DeletePersonGroupPersonFace } from "./DeletePersonGroupPersonFace.ts";

/**
 * Implementation of {@link DeletePersonGroupPersonFace} over the distilled `ai-face`
 * data plane. Assigns the custom `AzureAIPersonGroupFacesDeleteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeletePersonGroupPersonFace
 */
export const DeletePersonGroupPersonFaceHttp = Layer.effect(
  DeletePersonGroupPersonFace,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.DeletePersonGroupPersonFace",
    operation: face.DeletePersonGroupOperationPersonGroupPersonFace,
    grant: AIRole.PersonGroupFacesDelete,
  }),
);
